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

## AI jobs (0014, 2026-10-08)
Agent runs and `POST /api/ai/tasks` no longer run inside the synchronous API function (10 s default, 26 s max): the API
records a job in `core.ai_job` (status `queued`) and answers **202** with it; the background function
`netlify/functions/ai-worker-background.mts` (up to 15 min) runs it as the person who asked (their bearer token is
forwarded, plus the Team login cookie) and records `completed`/`failed`; the web app polls `GET /v1/ai/jobs/{id}`.
The ledger `core.ai_request` is unchanged: one immutable row per model call, written by the runtime; the job points to
it. Limits (AI-09): a job not started within `max_execution_s` (840 s) or a worker silent for 16 minutes is closed as
failed; one model call times out after `TRIALOPS_AI_TIMEOUT_MS` (default 360000) with one retry. Locally (dev:api, tests)
the job runs in the same process after the 202, the client polls the same way.
- Migration `0014_ai_jobs.sql` must be applied to the Supabase project before deploying this code.
- Worker URL: `${URL}/.netlify/functions/ai-worker-background` (Netlify sets `URL`); override with `TRIALOPS_WORKER_URL`.

## Access controls: MFA, lockout, idle timeout (0018, IAM-01 and CMP-03, 2026-10-10)
How it works:
- **Sign-in through the API.** The web app no longer calls `signInWithPassword`: it posts email + password to
  `POST /v1/auth/login`, the API checks the lock, makes the Supabase password grant server-side and returns the tokens,
  which the web app installs with `supabase.auth.setSession`. Failed attempts are recorded in `core.auth_event`; 5 within
  15 minutes lock the account for 30 minutes (`core.account_lock`), and so do failed signature re-authentications and
  wrong authenticator codes. While locked the API answers 423 without calling Supabase and refuses every token of that
  subject/email. Unlock: `POST /v1/admin/accounts/unlock` (platform admin, `X-Change-Reason`, audited); open locks:
  `GET /v1/admin/accounts/locks`.
- **MFA (TOTP).** After the password the token is `aal1`; the API refuses it (403 `mfa_required`) for every person with a
  role, except `GET /v1/me` and the sign-in routes. The web app then asks the code of the user's authenticator
  (screen TRO-091) or enrols a first one (TRO-092: QR code + setup key) with `supabase.auth.mfa.enroll`; the code is
  verified through `POST /v1/auth/mfa/verify` (Supabase challenge + verify with the user's token, failures counted) and
  the returned `aal2` session is installed. Signing asks password + code and records `reauth_mfa`; a person without a
  verified factor cannot sign while MFA is required.
- **Idle timeout.** Per Supabase `session_id`: `core.user_session.last_seen_at` is refreshed at most once a minute; after
  `TRIALOPS_IDLE_MINUTES` (default 15) without requests the API ends the session for good (401 `session_idle`,
  `session_idle_timeout` in `core.auth_event`). The browser has the same timer (warning 60 s before, keep-alive on user
  activity) and tells the API when it signs out (`POST /v1/auth/session/end`).
- Every row of `core.auth_event` and every lock/unlock and session start/end is in the hash-chained audit trail.
  Passwords and codes are never stored; emails are stored lowercased.

API environment (Netlify site, server-side):

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRIALOPS_MFA` | `required` | `off` disables the MFA check (never in a GxP production environment) |
| `TRIALOPS_MFA_EXEMPT_EMAIL_DOMAINS` | empty | **Demo deviation only**: comma list of email domains accepted at `aal1` (e.g. `demo.trialops.example` for the synthetic demo accounts); `/v1/me` reports `mfa.exempt: true`. Never allowed in a GxP production environment, where it must stay empty |
| `TRIALOPS_LOCKOUT_MAX` | `5` | failures that lock an account (the database never accepts fewer than 3) |
| `TRIALOPS_LOCKOUT_WINDOW_MIN` | `15` | window in minutes in which the failures are counted |
| `TRIALOPS_LOCKOUT_MINUTES` | `30` | duration of a lock |
| `TRIALOPS_IDLE_MINUTES` | `15` | inactivity after which a session ends |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` (or `VITE_SUPABASE_PUBLISHABLE_KEY`) | — | already set: password grant and MFA calls |

Supabase settings to make **before deploying this code** (documentation only: nothing has been changed on the project):
1. Apply `db/migrations/0018_access_controls.sql` (it creates the role `auth_service` and grants it to the migration
   user; the API takes it with `SET LOCAL ROLE auth_service`). Check afterwards, as the API user:
   `begin; set local role auth_service; select core.access_check('x', null, null, 15); rollback;` must answer `ok`.
2. Authentication → Multi-Factor → **TOTP: enabled** (enroll and verify). Leave phone MFA off.
3. Authentication → Sessions (recommended): inactivity timeout 15 minutes (same as `TRIALOPS_IDLE_MINUTES`), time-box
   12 hours; access token (JWT) expiry 900 s or less, so a token outlives its session as little as possible (the API
   already refuses tokens of ended sessions).
4. Authentication → Rate limits: the password grant and the MFA verify now come from the Netlify function, so all users
   share its addresses: raise the per-IP sign-in and MFA limits accordingly (the lockout in TrialOps is the per-account
   control).
5. API settings → exposed schemas: the web app does not use PostgREST. **Remove `core` from the exposed schemas** (step 2
   of the setup above was written for a PostgREST client that does not exist): otherwise an `aal1` token could read
   through RLS directly, bypassing the MFA and idle checks of the API.
6. Known limit: someone holding the publishable key can call the Supabase password grant directly, outside the TrialOps
   counter (Supabase's own rate limits apply). The resulting token is still `aal1` and refused by the API, and a locked
   account stays locked in TrialOps. Supabase's "password verification attempt" hook (paid plans) can close this.
7. The synthetic demo accounts have no authenticator: on the demo site either enrol one per account or set
   `TRIALOPS_MFA_EXEMPT_EMAIL_DOMAINS=demo.trialops.example` (documented deviation, demo only). The admin account
   (unified login) is not exempt: it enrols an authenticator at the first sign-in.
