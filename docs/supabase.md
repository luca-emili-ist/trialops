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
   grant select on core.person, core.role_assignment to supabase_auth_admin;   -- 0008 reads only these too
   ```
   then Authentication → Hooks → Custom Access Token → `core.custom_access_token_hook`.
4. Link people to Supabase users: `core.person.idp_sub` = `auth.users.id`.

The hook (0007, extended in 0008) adds `person_id`, `org_id`, `email`, `platform_ids`, `arm_scopes`, `site_scopes`
(`"*"` = all), `roles`, `blinding` and `actor_type` (APP-ID-02).
Agents and apps get tokens from the server with `actor_type` = `agent` / `app`; they are never unblinded (IAM-07).

## To verify with the existing user component
- that it uses Supabase Auth users (so `auth.users.id` is the stable subject);
- whether it already uses a custom access token hook (Supabase allows one: the two must be merged into one function);
- how its module flags (`user_has_module`) map to TrialOps roles.

## Deployed demo (2026-10-07)
- Supabase project `dbhmlvqrwkurxgeeidko` (IST org, eu-central-1, micro). DB password in the Keychain
  ("Supabase DB TrialOps (InSilicoTrials, eu-central-1)"). Migrations and seed with `scripts/db-remote.mjs` through the
  **transaction pooler** (`aws-1-eu-central-1.pooler.supabase.com:6543`; port 5432 is filtered on the office network).
- Auth: claims hook enabled (`pg-functions://postgres/core/custom_access_token_hook`), self-signup off, min password 10,
  JWT signed with ES256 (the API verifies with `TRIALOPS_JWKS_URL`).
- Users: synthetic demo users linked with `scripts/supabase-users.mjs demo` (shared password in the Keychain item
  "TrialOps demo users (InSilicoTrials, synthetic)"); the admin account with `scripts/create-admin.sh` (unified login).
- Netlify site `trialops` (IST team, Team login on): web app static, API as the function `netlify/functions/api.mts`.
  Deploy: `netlify deploy --prod --build --filter @trialops/web` (the filter avoids the monorepo prompt).
  Server-only secrets: `DATABASE_URL`, `TRIALOPS_OIDC_PRIVATE_JWK`. AI runs in replay until `TRIALOPS_AI_MODE=live` and
  `ANTHROPIC_API_KEY` (IST key) are set.
