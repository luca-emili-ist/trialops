-- TrialOps · 0021 data access log: unblinded reads and exports
-- Req: CMP-13 (ICH E6(R3) blinding, EMA computerised systems guideline / IRT, HIPAA §164.312(b)): every read of unblinded
-- data (schema sac_enclave) and every export of GxP records is recorded and can be reported.
--   * core.data_access_log is append-only (no update, delete or truncate) and written only by the functions below,
--     which take actor, time (server UTC, rule 11) and perimeter from the token, never from the caller;
--   * the SAC enclave is read only through sac_enclave.read_allocation(platform, reason): a person with the unblinded
--     claim, a reason, one log row per read with the number of rows returned. Direct select on the view is revoked;
--   * exports call core.log_export() with the SHA-256 of the file that left the system;
--   * core.access_log_search() reports the log to QA auditors and platform admins (same guard as the audit trail, 0019).
-- Idempotent: it can be run again.

create table if not exists core.data_access_log (
  seq            bigserial primary key,
  occurred_at    timestamptz not null default clock_timestamp(),
  actor_sub      text not null,
  actor_type     text not null check (actor_type in ('user', 'agent', 'app', 'system')),
  actor_email    text,
  kind           text not null check (kind in ('unblinded_read', 'export')),
  object         text not null check (length(object) between 1 and 200),
  platform_id    uuid references core.platform(id),
  record_id      uuid,
  filters        jsonb not null default '{}',
  row_count      int not null check (row_count >= 0),
  format         text check (format in ('csv', 'json', 'pdf', 'html', 'zip')),
  content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
  reason         text check (length(reason) <= 2000),
  check (kind <> 'unblinded_read' or length(btrim(coalesce(reason, ''))) > 0),
  check (kind <> 'export' or (format is not null and content_sha256 is not null))
);
comment on table core.data_access_log is 'Unblinded reads and exports (CMP-13); append-only, written by functions only, reported by core.access_log_search';
create index if not exists data_access_log_platform_idx on core.data_access_log (platform_id, occurred_at desc);

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.data_access_log'::regclass and tgname = 'no_change') then
    create trigger no_change before update or delete on core.data_access_log for each row execute function core.audit_immutable();
    create trigger no_truncate before truncate on core.data_access_log execute function core.audit_immutable();
  end if;
end $$;
revoke all on core.data_access_log from public, anon, authenticated, app_service, unblinded;
revoke all on sequence core.data_access_log_seq_seq from public, anon, authenticated, app_service, unblinded;

-- ===== exports =====
create or replace function core.log_export(p_object text, p_platform uuid, p_record uuid, p_filters jsonb, p_row_count int,
  p_format text, p_sha256 text, p_reason text default null) returns bigint
language plpgsql security definer set search_path = core, public as $$
declare v_seq bigint;
begin
  if p_platform is not null and core.claim_uuid_list('platform_ids') is not null
     and not p_platform = any(core.claim_uuid_list('platform_ids')) then
    raise exception 'export outside the platforms of the token (CMP-13)' using errcode = 'insufficient_privilege';
  end if;
  insert into core.data_access_log(actor_sub, actor_type, actor_email, kind, object, platform_id, record_id, filters, row_count,
    format, content_sha256, reason)
  values (core.current_sub(), core.current_actor_type(), lower(nullif(core.jwt()->>'email', '')), 'export', p_object, p_platform,
    p_record, coalesce(p_filters, '{}'), p_row_count, p_format, p_sha256, nullif(btrim(coalesce(p_reason, '')), ''))
  returning seq into v_seq;
  return v_seq;
end $$;

-- ===== SAC enclave =====
-- Allocation of the subjects of one platform, for the unblinded SAC statistician only. Agents and apps are never
-- unblinded (IAM-07), whatever the token says.
create or replace function sac_enclave.read_allocation(p_platform uuid, p_reason text)
returns table (subject_id uuid, platform_id uuid, site_id uuid, arm_id uuid, status text)
language plpgsql security definer set search_path = core, sac_enclave, public as $$
#variable_conflict use_column
declare v_n int;
begin
  if core.current_actor_type() <> 'user' or coalesce(core.jwt()->>'blinding', 'blinded') <> 'unblinded' then
    raise exception 'unblinded data is for SAC members only (IAM-04, IAM-07)' using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'reading unblinded data needs a reason (CMP-13)' using errcode = 'check_violation';
  end if;
  select count(*) into v_n from core.subject s where s.platform_id = p_platform;
  insert into core.data_access_log(actor_sub, actor_type, actor_email, kind, object, platform_id, filters, row_count, reason)
  values (core.current_sub(), core.current_actor_type(), lower(nullif(core.jwt()->>'email', '')), 'unblinded_read',
    'sac_enclave.subject_allocation', p_platform, jsonb_build_object('platform_id', p_platform), v_n, btrim(p_reason));
  return query select s.id, s.platform_id, s.site_id, s.arm_id, s.status::text from core.subject s where s.platform_id = p_platform;
end $$;

revoke select on sac_enclave.subject_allocation from unblinded;
revoke execute on function sac_enclave.read_allocation(uuid, text) from public;
grant execute on function sac_enclave.read_allocation(uuid, text) to unblinded;

-- ===== report =====
create or replace function core.access_log_search(p_platform uuid default null, p_kind text default null,
  p_from timestamptz default null, p_to timestamptz default null, p_limit int default 500)
returns table (seq bigint, occurred_at timestamptz, actor_sub text, actor_type text, actor_email text, kind text, object text,
               platform_id uuid, record_id uuid, filters jsonb, row_count int, format text, content_sha256 text, reason text)
language plpgsql stable security definer set search_path = core, public as $$
#variable_conflict use_column
begin
  perform core.audit_require_reviewer();
  return query
    select l.seq, l.occurred_at, l.actor_sub, l.actor_type, l.actor_email, l.kind, l.object, l.platform_id, l.record_id, l.filters,
           l.row_count, l.format, l.content_sha256, l.reason
      from core.data_access_log l
     where (p_platform is null or l.platform_id = p_platform)
       and (l.platform_id is null or core.claim_uuid_list('platform_ids') is null or l.platform_id = any(core.claim_uuid_list('platform_ids')))
       and (p_kind is null or l.kind = p_kind)
       and (p_from is null or l.occurred_at >= p_from)
       and (p_to is null or l.occurred_at < p_to)
     order by l.seq desc
     limit least(greatest(coalesce(p_limit, 500), 1), 10000);
end $$;

revoke execute on function core.log_export(text, uuid, uuid, jsonb, int, text, text, text),
  core.access_log_search(uuid, text, timestamptz, timestamptz, int) from public;
grant execute on function core.log_export(text, uuid, uuid, jsonb, int, text, text, text) to authenticated, app_service;
grant execute on function core.access_log_search(uuid, text, timestamptz, timestamptz, int) to authenticated;
