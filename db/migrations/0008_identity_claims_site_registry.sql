-- TrialOps · 0008 full token claims and site registry
-- Req: APP-ID-02 (claims sub, email, org_id, platform_ids, arm_scopes, roles, blinding), M02-01 (site registry)

-- APP-ID-02: the access token carries the standard claims plus the TrialOps perimeter and roles.
-- Same rules as 0007 for platforms/arms/sites/blinding; adds org_id, email and roles.
create or replace function core.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = core, public as $$
declare
  v_claims jsonb := coalesce(event->'claims', '{}');
  v_person core.person%rowtype;
  v_platforms jsonb; v_arms jsonb; v_sites jsonb; v_roles jsonb; v_unblinded boolean;
begin
  select * into v_person from core.person where idp_sub = event->>'user_id' and status = 'active';
  if v_person.id is null then
    return jsonb_set(event, '{claims}', v_claims || jsonb_build_object('platform_ids', '[]'::jsonb, 'roles', '[]'::jsonb));
  end if;
  with ra as (select * from core.role_assignment where person_id = v_person.id and status = 'active'
                and valid_from <= current_date and (valid_to is null or valid_to >= current_date))
  select coalesce(jsonb_agg(distinct platform_id) filter (where platform_id is not null), '[]'),
         case when bool_or(arm_id is null) then '"*"'::jsonb else coalesce(jsonb_agg(distinct arm_id) filter (where arm_id is not null), '[]') end,
         case when bool_or(site_id is null) then '"*"'::jsonb else coalesce(jsonb_agg(distinct site_id) filter (where site_id is not null), '[]') end,
         coalesce(jsonb_agg(distinct role) filter (where role is not null), '[]'),
         coalesce(bool_or(role = 'sac_member'), false)
    into v_platforms, v_arms, v_sites, v_roles, v_unblinded
  from ra;
  v_claims := v_claims || jsonb_build_object(
    'person_id', v_person.id,
    'org_id', v_person.org_id,
    'email', coalesce(v_claims->>'email', v_person.email),
    'platform_ids', coalesce(v_platforms, '[]'::jsonb),
    'arm_scopes', coalesce(v_arms, '[]'::jsonb),
    'site_scopes', coalesce(v_sites, '[]'::jsonb),
    'roles', coalesce(v_roles, '[]'::jsonb),
    'blinding', case when v_unblinded then 'unblinded' else 'blinded' end,
    'actor_type', 'user');
  return jsonb_set(event, '{claims}', v_claims);
end $$;
revoke execute on function core.custom_access_token_hook(jsonb) from public, authenticated, app_service;

-- M02-01: site registry — investigators, certifications, concurrent trials (capacity is core.site.declared_capacity_per_month)
create table core.site_investigator (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  site_id       uuid not null references core.site(id),
  person_id     uuid references core.person(id),       -- set when the investigator also has a TrialOps account
  full_name     text not null,
  investigator_role text not null check (investigator_role in ('principal','sub')),
  specialty     text,
  gcp_training_valid_until date,
  status        text not null default 'active' check (status in ('active','inactive','void')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.site_investigator');

create table core.site_certification (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  site_id       uuid not null references core.site(id),
  kind          text not null,                          -- e.g. 'GCP inspection', 'CLIA lab', 'Pharmacy IP handling'
  issuer        text,
  valid_until   date,
  status        text not null default 'active' check (status in ('active','expired','void')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.site_certification');

create table core.site_concurrent_trial (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  site_id       uuid not null references core.site(id),
  title         text not null,
  registry_id   text,                                   -- e.g. NCT number (synthetic in demo)
  competes_for_population boolean not null default false,
  status        text not null default 'ongoing' check (status in ('ongoing','completed','void')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.site_concurrent_trial');

do $$
declare t text;
begin
  foreach t in array array['site_investigator','site_certification','site_concurrent_trial'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('create policy scope on core.%I using (core.can_see_platform(platform_id) and core.can_see_site(site_id))
      with check (core.can_see_platform(platform_id) and core.can_see_site(site_id))', t);
    execute format('grant select, insert, update on core.%I to authenticated, app_service', t);
  end loop;
end $$;
