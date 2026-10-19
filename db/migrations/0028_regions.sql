-- TrialOps · 0028 regions: one deployment serves one data region (EU, US or JP), data never crosses it
-- Req: NFR-06 (same code deployable in EU, US and Japan with data kept separate per region; GDPR art. 44, APPI art. 28,
--      HIPAA §164.312), rule 15 of CLAUDE.md. Builds on the data region per platform of 0026 (CMP-08).
-- Design (procedure in docs/compliance/REGIONS.md):
--   * a deployment is one Supabase project + one Netlify site per region, with the same code. The database records its
--     own region once (core.deployment, set by the owner with core.set_deployment_region, never changed);
--   * once the database has a region, a platform of another region can be neither created nor moved there: a new
--     platform without a region takes the region of the database (core.platform_region_in_deployment);
--   * the Platform API compares its TRIALOPS_DEPLOYMENT_REGION with core.deployment_region() and refuses to serve when they
--     differ; it reads the regions of the platforms of a request with core.platform_regions() and refuses a request for
--     a platform of another region, recording it with core.log_region_refusal() (append-only, audited);
--   * nothing here copies data between regions: there is no replication, no foreign table, no export.
-- Grants: execute on core.deployment_region, core.platform_regions and core.log_region_refusal to the API roles;
-- core.set_deployment_region only for the owner (migration login). No grant on the new tables to any API role: they are
-- read through the functions. No change to existing grants or RLS policies; one new trigger on core.platform.
-- Idempotent: it can be run again.

-- =====================================================================================================================
-- the region of this database
-- =====================================================================================================================
create table if not exists core.deployment (
  id      uuid primary key default gen_random_uuid(),
  region  text not null check (region in ('EU', 'US', 'JP')),
  note    text check (length(note) <= 1000),
  set_by  text not null default core.current_sub(),
  set_at  timestamptz not null default clock_timestamp()
);
comment on table core.deployment is 'The data region served by this database (NFR-06): one row, set once by the owner, never changed';
create unique index if not exists deployment_single_row on core.deployment ((true));

-- A region is set once: the row is never updated (the audit trigger below also forbids deletes).
create or replace function core.deployment_fixed() returns trigger language plpgsql as $$
begin
  raise exception 'the region of a deployment is set once: this database serves % (NFR-06)', old.region using errcode = 'check_violation';
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.deployment'::regclass and tgname = 'audit') then
    perform core.attach_std('core.deployment', 'gxp');
    create trigger fixed before update on core.deployment for each row execute function core.deployment_fixed();
    create trigger no_truncate before truncate on core.deployment execute function core.audit_immutable();
  end if;
end $$;
revoke all on core.deployment from public, anon, authenticated, app_service;

create or replace function core.deployment_region() returns text language sql stable security definer set search_path = core, public as $$
  select region from core.deployment limit 1
$$;

-- Set by the owner after the migrations of a new regional database (docs/compliance/REGIONS.md, step 3). Refused when the
-- database already holds a platform of another region: such data must never have been there.
create or replace function core.set_deployment_region(p_region text, p_note text default null) returns text
language plpgsql security definer set search_path = core, public as $$
declare v_current text := core.deployment_region(); v_other text;
begin
  if p_region is null or p_region not in ('EU', 'US', 'JP') then
    raise exception 'region must be EU, US or JP (NFR-06)' using errcode = 'check_violation';
  end if;
  if v_current is not null then
    if v_current = p_region then return v_current; end if;
    raise exception 'the region of a deployment is set once: this database serves % (NFR-06)', v_current using errcode = 'check_violation';
  end if;
  select string_agg(code || ' (' || data_region || ')', ', ' order by code) into v_other
    from core.platform where data_region is not null and data_region <> p_region and status <> 'void';
  if v_other is not null then
    raise exception 'this database holds platforms of another region: % (NFR-06): they belong to their own regional deployment', v_other
      using errcode = 'check_violation';
  end if;
  perform set_config('trialops.change_reason', coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'deployment region set (NFR-06)'), true);
  insert into core.deployment(region, note) values (p_region, nullif(btrim(coalesce(p_note, '')), ''));
  return p_region;
end $$;

-- =====================================================================================================================
-- platforms of this database stay in its region
-- =====================================================================================================================
create or replace function core.platform_region_in_deployment() returns trigger language plpgsql as $$
declare v_region text := core.deployment_region();
begin
  if v_region is null then return new; end if;
  if tg_op = 'INSERT' and new.data_region is null then new.data_region := v_region; end if;
  if new.data_region is not null and new.data_region <> v_region then
    raise exception 'platform % keeps its data in %: it cannot be stored in the % deployment (NFR-06)', new.code, new.data_region, v_region
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists region_in_deployment on core.platform;
create trigger region_in_deployment before insert or update of data_region on core.platform
  for each row execute function core.platform_region_in_deployment();

-- Region of the given platforms (all non-void platforms when p_ids is null), for the region gate of the API. Only the id
-- and the region are returned: no title, no data of the platform.
create or replace function core.platform_regions(p_ids uuid[]) returns table (id uuid, code text, data_region text)
language sql stable security definer set search_path = core, public as $$
  select p.id, p.code, p.data_region from core.platform p
   where (p_ids is null and p.status <> 'void') or p.id = any(p_ids)
$$;

-- =====================================================================================================================
-- refused cross-region requests: append-only and audited
-- =====================================================================================================================
create table if not exists core.region_access_refusal (
  id                 uuid primary key default gen_random_uuid(),
  occurred_at        timestamptz not null default clock_timestamp(),
  actor_sub          text not null,
  actor_type         text not null check (actor_type in ('user', 'agent', 'app', 'system', 'anon')),
  actor_email        text,
  deployment_region  text not null check (deployment_region in ('EU', 'US', 'JP')),
  platform_id        uuid references core.platform(id),
  platform_region    text check (platform_region in ('EU', 'US', 'JP')),
  method             text not null check (method in ('GET', 'POST', 'PATCH', 'PUT', 'DELETE')),
  path               text not null check (length(path) between 1 and 500)
);
comment on table core.region_access_refusal is 'Requests refused because they asked for a platform of another region (NFR-06); append-only, audited';
create index if not exists region_access_refusal_time_idx on core.region_access_refusal (occurred_at desc);

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.region_access_refusal'::regclass and tgname = 'audit') then
    create trigger audit after insert on core.region_access_refusal for each row execute function core.audit_row('operational');
    create trigger immutable before update or delete on core.region_access_refusal for each row execute function core.audit_immutable();
    create trigger immutable_truncate before truncate on core.region_access_refusal execute function core.audit_immutable();
  end if;
end $$;
revoke all on core.region_access_refusal from public, anon, authenticated, app_service;

-- Written by the API in its own transaction (the refused request is rolled back). Actor and time from the token and the
-- server clock (rule 11), never from the caller.
create or replace function core.log_region_refusal(p_deployment_region text, p_platform uuid, p_platform_region text, p_method text, p_path text)
returns uuid language plpgsql security definer set search_path = core, public as $$
declare v_id uuid;
begin
  insert into core.region_access_refusal(actor_sub, actor_type, actor_email, deployment_region, platform_id, platform_region, method, path)
  values (core.current_sub(), core.current_actor_type(), lower(nullif(core.jwt()->>'email', '')), p_deployment_region,
    (select id from core.platform where id = p_platform), p_platform_region, upper(p_method), left(p_path, 500))
  returning id into v_id;
  return v_id;
end $$;

-- Refusals for QA auditors and platform admins (same readers as the access log).
create or replace function core.region_refusal_search(p_limit int default 200) returns setof core.region_access_refusal
language plpgsql stable security definer set search_path = core, public as $$
begin
  perform core.audit_require_reviewer();   -- QA auditors and platform admins, persons only (0019)
  return query select * from core.region_access_refusal order by occurred_at desc limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end $$;

revoke execute on function core.deployment_fixed(), core.deployment_region(), core.set_deployment_region(text, text),
  core.platform_region_in_deployment(), core.platform_regions(uuid[]), core.log_region_refusal(text, uuid, text, text, text),
  core.region_refusal_search(int) from public;
grant execute on function core.deployment_region() to anon, authenticated, app_service;
grant execute on function core.platform_regions(uuid[]), core.log_region_refusal(text, uuid, text, text, text) to authenticated, app_service;
grant execute on function core.region_refusal_search(int) to authenticated;
