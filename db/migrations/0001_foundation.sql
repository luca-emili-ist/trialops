-- TrialOps · 0001 foundation: schemas, roles, JWT claim helpers
-- Req: IAM-02, ARC-04
create schema if not exists core;
create schema if not exists sac_enclave;   -- IAM-04: unblinded data lives here only

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_service') then create role app_service nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'unblinded') then create role unblinded nologin; end if;
end $$;

grant usage on schema core to authenticated, app_service;
revoke all on schema sac_enclave from public;
grant usage on schema sac_enclave to unblinded;

-- JWT claims as injected by PostgREST / Platform API (request.jwt.claims GUC)
create or replace function core.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function core.current_sub() returns text language sql stable as $$
  select coalesce(core.jwt()->>'sub', current_setting('trialops.actor', true), 'system:' || current_user)
$$;

create or replace function core.current_actor_type() returns text language sql stable as $$
  select coalesce(core.jwt()->>'actor_type', 'user')
$$;

-- '*' in a scope claim means "all" within the granted platforms
create or replace function core.claim_uuid_list(claim text) returns uuid[] language sql stable as $$
  select case
    when core.jwt()->claim is null then array[]::uuid[]
    when core.jwt()->claim = '"*"'::jsonb then null      -- null = unrestricted
    else array(select jsonb_array_elements_text(core.jwt()->claim)::uuid)
  end
$$;

create or replace function core.can_see_platform(p uuid) returns boolean language sql stable as $$
  select current_user not in ('authenticated','app_service')            -- owners / migrations bypass
      or core.claim_uuid_list('platform_ids') is null
      or p = any(core.claim_uuid_list('platform_ids'))
$$;

create or replace function core.can_see_arm(p uuid, a uuid) returns boolean language sql stable as $$
  select core.can_see_platform(p) and (
       current_user not in ('authenticated','app_service')
    or a is null                                           -- platform-level object
    or core.claim_uuid_list('arm_scopes') is null
    or a = any(core.claim_uuid_list('arm_scopes')))
$$;

create or replace function core.can_see_site(s uuid) returns boolean language sql stable as $$
  select current_user not in ('authenticated','app_service')
      or s is null
      or core.claim_uuid_list('site_scopes') is null
      or s = any(core.claim_uuid_list('site_scopes'))
$$;

create or replace function core.is_unblinded() returns boolean language sql stable as $$
  select coalesce(core.jwt()->>'blinding', 'blinded') = 'unblinded' and core.current_actor_type() <> 'agent'
$$;

-- shared updated_at / version bump
create or replace function core.touch() returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  if tg_op = 'UPDATE' then new.row_version := old.row_version + 1; end if;
  return new;
end $$;
