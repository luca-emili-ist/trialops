-- TrialOps · 0024 idempotent writes and provenance of app-written data
-- Req: APP-DT-02 (writes carry an Idempotency-Key; a retried write returns the stored response, a reused key with another
--      request is refused), APP-DT-05 (every datum written by an app records source_app, source_record_id, source_version,
--      transformation_id).
--   * core.idempotency_record keeps, per caller and key, the hash of the request and the response of the first successful
--     write, for 24 hours. It is a replay cache of the API, not a GxP record: the write itself is audited by its table.
--     No API role reads or writes it directly; only the two functions below, which take the caller from the token.
--     Rows cannot be updated; they can be deleted only once expired (retention = expires_at).
--   * Provenance: the API puts the provenance the app supplied (headers X-Source-Record-Id, X-Source-Version,
--     X-Transformation-Id) in the setting trialops.provenance; source_app always comes from the verified token (app_id).
--     core.stamp_provenance() refuses an app write without it and stamps it on the row, so it is in the row and, through
--     core.audit_row(), in the audit trail. People and agents cannot set or change provenance.
-- Grants: execute on the two idempotency functions to authenticated and app_service (revoked from public); select on the
-- provenance columns of core.subject (column-level grants like the other columns of that table). No REVOKE on existing
-- objects, no RLS change on existing tables.
-- Idempotent: it can be run again.

-- ===== idempotency (APP-DT-02) =====
create table if not exists core.idempotency_record (
  caller           text not null,                       -- sub of the token, plus '@<app_id>' for apps
  idem_key         text not null check (idem_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  actor_type       text not null check (actor_type in ('user', 'agent', 'app', 'system')),
  method           text not null check (method in ('POST', 'PUT', 'PATCH')),
  path             text not null check (length(path) between 1 and 2000),
  request_sha256   text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_status  int not null check (response_status between 200 and 299),
  response_headers jsonb not null default '{}',
  response_body    jsonb,
  response_text    text,
  created_at       timestamptz not null default clock_timestamp(),
  expires_at       timestamptz not null default clock_timestamp() + interval '24 hours',
  primary key (caller, idem_key),
  check (expires_at > created_at)
);
comment on table core.idempotency_record is
  'Replay cache of API writes (APP-DT-02): first successful response per caller and Idempotency-Key, kept 24 h; not a GxP record';
create index if not exists idempotency_record_expiry_idx on core.idempotency_record (expires_at);

-- No update ever; delete only of expired rows (retention); no truncate.
create or replace function core.idempotency_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.expires_at <= clock_timestamp() then return old; end if;
  raise exception 'core.idempotency_record rows cannot be changed, only removed after expiry (APP-DT-02)'
    using errcode = 'insufficient_privilege';
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.idempotency_record'::regclass and tgname = 'guard') then
    create trigger guard before update or delete on core.idempotency_record for each row execute function core.idempotency_guard();
    create trigger guard_truncate before truncate on core.idempotency_record execute function core.audit_immutable();
  end if;
end $$;
alter table core.idempotency_record enable row level security;
revoke all on core.idempotency_record from public, anon, authenticated, app_service, unblinded;

create or replace function core.idempotency_caller() returns text language sql stable as $$
  select core.current_sub() || coalesce('@' || nullif(core.jwt()->>'app_id', ''), '')
$$;

-- The stored response of the caller's key, if not expired.
create or replace function core.idempotency_lookup(p_key text)
returns table (method text, path text, request_sha256 text, response_status int, response_headers jsonb, response_body jsonb,
               response_text text, created_at timestamptz)
language sql stable security definer set search_path = core, public as $$
  select r.method, r.path, r.request_sha256, r.response_status, r.response_headers, r.response_body, r.response_text, r.created_at
    from core.idempotency_record r
   where r.caller = core.idempotency_caller() and r.idem_key = p_key and r.expires_at > clock_timestamp()
$$;

-- Stores the response in the transaction of the write: both commit or neither. A concurrent request with the same key
-- fails on the primary key and its own write is rolled back.
create or replace function core.idempotency_store(p_key text, p_method text, p_path text, p_sha256 text, p_status int,
  p_headers jsonb, p_body jsonb, p_text text) returns void
language plpgsql security definer set search_path = core, public as $$
begin
  if core.current_actor_type() not in ('user', 'agent', 'app') then
    raise exception 'idempotency keys are for authenticated callers (APP-DT-02)' using errcode = 'insufficient_privilege';
  end if;
  -- an expired entry of the same key gives way (the guard allows deleting expired rows only)
  delete from core.idempotency_record where caller = core.idempotency_caller() and idem_key = p_key and expires_at <= clock_timestamp();
  insert into core.idempotency_record(caller, idem_key, actor_type, method, path, request_sha256, response_status, response_headers,
    response_body, response_text)
  values (core.idempotency_caller(), p_key, core.current_actor_type(), upper(p_method), p_path, p_sha256, p_status,
    coalesce(p_headers, '{}'), p_body, p_text);
end $$;

-- Retention: removes expired entries (scheduled maintenance); returns the number removed.
create or replace function core.idempotency_purge() returns int
language plpgsql security definer set search_path = core, public as $$
declare n int;
begin
  delete from core.idempotency_record where expires_at <= clock_timestamp();
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function core.idempotency_lookup(text), core.idempotency_store(text, text, text, text, int, jsonb, jsonb, text),
  core.idempotency_purge() from public;
grant execute on function core.idempotency_lookup(text), core.idempotency_store(text, text, text, text, int, jsonb, jsonb, text)
  to authenticated, app_service;

-- ===== provenance of app-written data (APP-DT-05) =====
create or replace function core.stamp_provenance() returns trigger language plpgsql as $$
declare
  p jsonb := nullif(current_setting('trialops.provenance', true), '')::jsonb;
  v_app text := nullif(core.jwt()->>'app_id', '');
begin
  if core.current_actor_type() = 'app' then
    if v_app is null or p is null
       or length(btrim(coalesce(p->>'source_record_id', ''))) = 0
       or length(btrim(coalesce(p->>'source_version', ''))) = 0
       or length(btrim(coalesce(p->>'transformation_id', ''))) = 0 then
      raise exception 'app write to % without provenance: source_app, source_record_id, source_version and transformation_id are required (APP-DT-05)',
        tg_table_name using errcode = 'check_violation';
    end if;
    new.source_app := v_app;
    new.source_record_id := p->>'source_record_id';
    new.source_version := p->>'source_version';
    new.transformation_id := p->>'transformation_id';
  elsif tg_op = 'INSERT' then
    -- written by a person, an agent or the system: no app provenance, and nobody can claim one
    new.source_app := null; new.source_record_id := null; new.source_version := null; new.transformation_id := null;
  else
    -- a later change by a person keeps the origin of the record; the change itself is in the audit trail
    new.source_app := old.source_app; new.source_record_id := old.source_record_id;
    new.source_version := old.source_version; new.transformation_id := old.transformation_id;
  end if;
  return new;
end $$;

-- Every audited record table an app can write (insert granted to app_service). The AI ledger (ai_request,
-- agent_decision_record) and signatures are excluded: their provenance is the model/prompt (AI-06) and the signer (CMP-02).
do $$
declare t text;
begin
  foreach t in array array['platform', 'role_assignment', 'master_protocol_version', 'arm', 'arm_appendix_version',
    'arm_stage_transition', 'control_sharing_rule', 'site', 'site_arm_activation', 'site_investigator', 'site_certification',
    'site_concurrent_trial', 'subject', 'submission', 'contract', 'document', 'document_version', 'deviation', 'adverse_event',
    'task', 'time_entry'] loop
    execute format('alter table core.%I add column if not exists source_app text check (length(source_app) <= 200)', t);
    execute format('alter table core.%I add column if not exists source_record_id text check (length(source_record_id) <= 200)', t);
    execute format('alter table core.%I add column if not exists source_version text check (length(source_version) <= 200)', t);
    execute format('alter table core.%I add column if not exists transformation_id text check (length(transformation_id) <= 200)', t);
    if not exists (select 1 from pg_trigger where tgrelid = format('core.%I', t)::regclass and tgname = 'provenance') then
      execute format('create trigger provenance before insert or update on core.%I for each row execute function core.stamp_provenance()', t);
    end if;
    execute format('comment on column core.%I.source_app is %L', t, 'App that wrote the current origin of the row, from the verified token (APP-DT-05)');
  end loop;
end $$;
create index if not exists subject_source_idx on core.subject (source_app, source_record_id) where source_app is not null;

-- core.subject has column-level grants (0006): the provenance columns are readable, never written by the caller.
grant select (source_app, source_record_id, source_version, transformation_id) on core.subject to authenticated, app_service;
