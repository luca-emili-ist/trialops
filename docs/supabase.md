# Running TrialOps on Supabase (decisions 2 and 6, 2026-10-06)

TrialOps runs on Supabase for now, with the user-management component already used by the other IST applications
(Supabase Auth). Nothing in the migrations is Supabase-specific: RLS reads `request.jwt.claims`, which Supabase and
plain PostgREST both set, so a later move to Azure (PostgreSQL + PostgREST + Entra ID) needs no schema change.

## Setup on a Supabase project
1. Apply `db/migrations/*.sql` in order (Supabase SQL editor or `supabase db push`). Roles `anon` and
   `authenticated` already exist; `app_service` and `unblinded` are created by 0001.
2. API settings → exposed schemas: add `core`. Do **not** expose `sac_enclave` through the public API; the SAC
   reads it through a dedicated server-side endpoint.
3. Custom access token hook (0007): grant and enable it
   ```sql
   grant usage on schema core to supabase_auth_admin;
   grant execute on function core.custom_access_token_hook(jsonb) to supabase_auth_admin;
   grant select on core.person, core.role_assignment to supabase_auth_admin;
   ```
   then Authentication → Hooks → Custom Access Token → `core.custom_access_token_hook`.
4. Link people to Supabase users: `core.person.idp_sub` = `auth.users.id`.

The hook adds `person_id`, `platform_ids`, `arm_scopes`, `site_scopes` (`"*"` = all), `blinding` and `actor_type`.
Agents and apps get tokens from the server with `actor_type` = `agent` / `app`; they are never unblinded (IAM-07).

## To verify with the existing user component
- that it uses Supabase Auth users (so `auth.users.id` is the stable subject);
- whether it already uses a custom access token hook (Supabase allows one: the two must be merged into one function);
- how its module flags (`user_has_module`) map to TrialOps roles.
