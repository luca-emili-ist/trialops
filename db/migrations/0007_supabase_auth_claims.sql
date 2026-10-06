-- TrialOps · 0007 claims for the existing user-management component (Supabase Auth)
-- Decision 6 (2026-10-06): reuse the user component built for the other IST applications.
-- Supabase calls this function as a "custom access token hook" and puts the result in every JWT,
-- so RLS (IAM-02) keeps reading request.jwt.claims exactly as with any other identity provider.
-- Req: IAM-02, IAM-04, IAM-07, APP-ID-02
-- Simplification for the demo: scopes are the union over all platforms the person is assigned to.

create or replace function core.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = core, public as $$
declare
  v_claims jsonb := coalesce(event->'claims', '{}');
  v_person uuid;
  v_platforms jsonb; v_arms jsonb; v_sites jsonb; v_unblinded boolean;
begin
  select id into v_person from core.person where idp_sub = event->>'user_id' and status = 'active';
  if v_person is null then
    return jsonb_set(event, '{claims}', v_claims || jsonb_build_object('platform_ids', '[]'::jsonb));
  end if;
  with ra as (select * from core.role_assignment where person_id = v_person and status = 'active'
                and valid_from <= current_date and (valid_to is null or valid_to >= current_date))
  select coalesce(jsonb_agg(distinct platform_id) filter (where platform_id is not null), '[]'),
         case when bool_or(arm_id is null) then '"*"'::jsonb else coalesce(jsonb_agg(distinct arm_id) filter (where arm_id is not null), '[]') end,
         case when bool_or(site_id is null) then '"*"'::jsonb else coalesce(jsonb_agg(distinct site_id) filter (where site_id is not null), '[]') end,
         coalesce(bool_or(role = 'sac_member'), false)
    into v_platforms, v_arms, v_sites, v_unblinded
  from ra;
  v_claims := v_claims || jsonb_build_object(
    'person_id', v_person,
    'platform_ids', coalesce(v_platforms, '[]'::jsonb),
    'arm_scopes', coalesce(v_arms, '[]'::jsonb),
    'site_scopes', coalesce(v_sites, '[]'::jsonb),
    'blinding', case when v_unblinded then 'unblinded' else 'blinded' end,
    'actor_type', 'user');
  return jsonb_set(event, '{claims}', v_claims);
end $$;

-- On Supabase: grant execute to supabase_auth_admin and enable the hook in Auth settings (see docs/supabase.md).
revoke execute on function core.custom_access_token_hook(jsonb) from public, authenticated, app_service;
