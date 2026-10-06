-- TrialOps · 0013 app roles and OIDC single sign-on towards installed apps
-- Req: APP-ID-01 (TrialOps is the only IdP of the apps: authorization code + PKCE), APP-ID-02 (claims in the ID token),
--      APP-ID-04 (app roles are declared in the manifest and assigned in TrialOps), APP-MF-04 (uninstall stops access)

create table core.app_role_assignment (
  id              uuid primary key default gen_random_uuid(),
  platform_id     uuid not null references core.platform(id),
  installation_id uuid not null references core.app_installation(id),
  person_id       uuid not null references core.person(id),
  role            text not null,
  status          text not null default 'active' check (status in ('active','ended','void')),
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  row_version     int not null default 1
);
select core.attach_std('core.app_role_assignment');
create unique index on core.app_role_assignment (installation_id, person_id, role) where status = 'active';

create or replace function core.app_role_declared() returns trigger language plpgsql as $$
declare m jsonb;
begin
  select manifest into m from core.app_installation where id = new.installation_id;
  if not coalesce((m->'roles') ? new.role, false) then
    raise exception 'role % is not declared in the app manifest (APP-ID-04)', new.role using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger role_declared before insert or update on core.app_role_assignment for each row execute function core.app_role_declared();

alter table core.app_role_assignment enable row level security;
create policy scope on core.app_role_assignment using (core.can_see_platform(platform_id)) with check (core.can_see_platform(platform_id));
grant select, insert, update on core.app_role_assignment to authenticated;

-- Authorization codes: single use, 60 seconds, stored hashed, readable by nobody; only the two functions below touch them.
create table core.oidc_code (
  code_sha256     text primary key,
  platform_id     uuid not null references core.platform(id),
  installation_id uuid not null references core.app_installation(id),
  redirect_uri    text not null,
  code_challenge  text not null,
  nonce           text,
  claims          jsonb not null,
  expires_at      timestamptz not null default clock_timestamp() + interval '60 seconds',
  used_at         timestamptz
);
alter table core.oidc_code enable row level security;
revoke all on core.oidc_code from public;

-- Issued for the signed-in caller (claims of the verified token), after checking app, redirect URI and perimeter.
create or replace function core.oidc_issue_code(p_code_sha256 text, p_client_id text, p_platform uuid, p_redirect text,
  p_challenge text, p_nonce text) returns void language plpgsql security definer set search_path = core, public as $$
declare i core.app_installation%rowtype; v_claims jsonb := core.jwt(); v_roles jsonb;
begin
  if core.current_actor_type() <> 'user' then
    raise exception 'single sign-on is for people (APP-ID-01)' using errcode = 'insufficient_privilege';
  end if;
  if not core.can_see_platform(p_platform) or not coalesce(v_claims->'platform_ids' ? p_platform::text, false) then
    raise exception 'no access to this platform (IAM-02)' using errcode = 'insufficient_privilege';
  end if;
  select * into i from core.app_installation where app_id = p_client_id and platform_id = p_platform;
  if i.id is null or i.status <> 'active' then
    raise exception 'app % is not installed and active on this platform (APP-MF-04)', p_client_id using errcode = 'insufficient_privilege';
  end if;
  if not coalesce(i.manifest->'auth'->'oidc_redirect_uris' ? p_redirect, false) then
    raise exception 'redirect_uri is not registered in the app manifest (APP-ID-01)' using errcode = 'check_violation';
  end if;
  select coalesce(jsonb_agg(distinct r.role), '[]') into v_roles from core.app_role_assignment r
    where r.installation_id = i.id and r.status = 'active' and r.person_id = (v_claims->>'person_id')::uuid;
  insert into core.oidc_code(code_sha256, platform_id, installation_id, redirect_uri, code_challenge, nonce, claims)
  values (p_code_sha256, p_platform, i.id, p_redirect, p_challenge, p_nonce,
    jsonb_build_object('sub', v_claims->>'sub', 'email', v_claims->>'email', 'org_id', v_claims->>'org_id',
      'person_id', v_claims->>'person_id', 'platform_ids', jsonb_build_array(p_platform), 'arm_scopes', v_claims->'arm_scopes',
      'site_scopes', v_claims->'site_scopes', 'roles', v_roles, 'blinding', coalesce(v_claims->>'blinding', 'blinded')));
end $$;

-- Redeemed by the app at the token endpoint (anonymous caller): checks client, redirect URI, PKCE, expiry, single use.
create or replace function core.oidc_redeem_code(p_code_sha256 text, p_client_id text, p_redirect text, p_challenge text)
returns jsonb language plpgsql security definer set search_path = core, public as $$
declare c core.oidc_code%rowtype; i core.app_installation%rowtype;
begin
  select * into c from core.oidc_code where code_sha256 = p_code_sha256 for update;
  if c.code_sha256 is null or c.used_at is not null or c.expires_at < clock_timestamp() then
    return jsonb_build_object('error', 'invalid_grant', 'error_description', 'code unknown, used or expired');
  end if;
  -- burnt on first presentation, also when the checks below fail (returns instead of raising so the burn commits)
  update core.oidc_code set used_at = clock_timestamp() where code_sha256 = p_code_sha256;
  select * into i from core.app_installation where id = c.installation_id;
  if i.app_id <> p_client_id or c.redirect_uri <> p_redirect or c.code_challenge <> p_challenge or i.status <> 'active' then
    return jsonb_build_object('error', 'invalid_grant', 'error_description', 'client, redirect_uri or code_verifier mismatch');
  end if;
  return c.claims || jsonb_build_object('nonce', c.nonce, 'app_id', i.app_id, 'gxp_class', i.gxp_class,
    'scopes', (select coalesce(jsonb_agg(scope), '[]') from core.app_scope_grant where installation_id = i.id and revoked_at is null));
end $$;

revoke execute on function core.oidc_issue_code(text, text, uuid, text, text, text) from public;
revoke execute on function core.oidc_redeem_code(text, text, text, text) from public;
grant execute on function core.oidc_issue_code(text, text, uuid, text, text, text) to authenticated;
grant usage on schema core to anon;
grant execute on function core.oidc_redeem_code(text, text, text, text) to anon;

-- Scope grants are written by the database on approval/uninstall, never by the caller directly: the lifecycle trigger
-- of 0005 runs with the owner's rights so that an approved installation can grant scopes the caller cannot insert.
alter function core.app_lifecycle() security definer set search_path = core, public;
