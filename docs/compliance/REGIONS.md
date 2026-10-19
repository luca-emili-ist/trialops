# Regions — one deployment per data region (NFR-06)

Requirement NFR-06 (v1, GxP impact direct, risk high): *the same code deployable in EU, US and Japan regions with data
kept separate per region* (GDPR art. 44, APPI art. 28, HIPAA §164.312; rule 15 of `CLAUDE.md`). This page is the
deployment recipe and the description of the controls. Status: code and tests done (2026-10-19, branch
`v1-regions-a11y-ui`); no regional deployment has been provisioned yet.

## 1. Model

```
             same git commit, same build
   ┌────────────────────┬────────────────────┬────────────────────┐
   │  EU deployment     │  US deployment     │  JP deployment     │
   │  Netlify site      │  Netlify site      │  Netlify site      │
   │  TRIALOPS_         │  TRIALOPS_         │  TRIALOPS_         │
   │  DEPLOYMENT_       │  DEPLOYMENT_       │  DEPLOYMENT_       │
   │  REGION=EU         │  REGION=US         │  REGION=JP         │
   │        │           │        │           │        │           │
   │  Supabase project  │  Supabase project  │  Supabase project  │
   │  EU (Frankfurt)    │  US (e.g. us-east) │  JP (Tokyo)        │
   │  core.deployment   │  core.deployment   │  core.deployment   │
   │  = EU              │  = US              │  = JP              │
   └────────────────────┴────────────────────┴────────────────────┘
        no replication, no foreign tables, no cross-region export
```

- **One Supabase project and one Netlify site per region**, built from the same commit. A platform (and all its arms,
  sites, subjects, tasks, documents, audit trail) lives in exactly one regional database; `core.platform.data_region`
  (0026, set once) says which.
- **Nothing is copied between regions.** There is no replication, no `postgres_fdw`, no cross-region backup restore and no
  export endpoint that targets another deployment. Backups stay in the region of their project (Supabase keeps them in
  the project region; NFR-04 restore tests are run per region).
- **People** may hold accounts in several regions (one Supabase Auth user per regional project). Accounts are not
  synchronised: each region has its own identity store, MFA factors and audit trail.
- **AI providers** are service providers (CMP-08): each regional deployment names its AI provider in
  `TRIALOPS_AI_PROVIDER_CODE`, and the provider must be active on the platform for the data category, process in the
  platform region and have its agreements (DPA / BAA / APPI basis) before platform data reaches it.
- **Apps** declare `data_residency` in their manifest (`EU`, `US`, `JP`); a regional deployment offers and installs only
  apps that keep their data in its region.

## 2. Controls in the code

| Layer | Control | Where |
| --- | --- | --- |
| Database | The database records its own region once (`core.deployment`, `core.set_deployment_region()`, owner only, audited, never updated) | `db/migrations/0028_regions.sql` |
| Database | Once the region is set, a platform of another region can be neither created nor moved there; a new platform without a region takes the region of the database; setting the region is refused if the database holds a platform of another region | `core.platform_region_in_deployment()`, `core.set_deployment_region()` |
| Database | Data region of a platform set once (0026); participant data only to providers processing in that region with agreements; apps activated only when `data_residency` covers the platform region | `db/migrations/0026_quality_privacy_governance.sql` |
| API | `TRIALOPS_DEPLOYMENT_REGION` (EU, US, JP; other values stop the start-up). The API refuses to serve (503 `region_misconfigured`) when the database declares another region, or declares one while the API is not pinned | `packages/api/src/lib/region.ts` |
| API | A request that names a platform of another region (`/v1/platforms/:id/...`, `platform_id` in the query or the body) is refused with 403 `wrong_region` and recorded in `core.region_access_refusal` (append-only, audited, in its own transaction) | `RegionGate.enforce` |
| API | The platform perimeter of the token is narrowed to the platforms of the region, so RLS hides every record of another region on every other route (fail closed) | `RegionGate.enforce` |
| API | App catalogue marks `available_in_region`; installation refused (422 `residency_mismatch`) when `data_residency` does not cover the deployment region or the platform region | `packages/api/src/routes/apps.ts` |
| AI runtime | Before a model call with platform data: `core.provider_allowed(platform, TRIALOPS_AI_PROVIDER_CODE, category)`; refused calls are ledgered as `blocked`. A pinned deployment without `TRIALOPS_AI_PROVIDER_CODE` refuses every external call with platform data; replay answers never leave the deployment | `services/ai-runtime/src/runtime.ts` |
| Reporting | `GET /v1/health` and `GET /v1/region` show the deployment and database regions; `GET /v1/region/refusals` (QA auditor, platform admin) lists refused requests | `packages/api/src/routes/platform.ts` |

Not pinned (`TRIALOPS_DEPLOYMENT_REGION` empty): local development, tests and the **transitional demo** serve every
platform of their database. This mode is not for GxP use: a regional production deployment always sets the variable.

## 3. Recipe for a new regional deployment

All steps are infrastructure provisioning (`CLAUDE.md` of the workspace: each needs an explicit yes of Luca Emili). Values
in angle brackets are per region.

1. **Supabase project** in the region (`supabase projects create trialops-<region> --region <eu-central-1 | us-east-1 |
   ap-northeast-1> --org-id <org>`), plan with PITR when it holds real data. Auth settings as in `docs/supabase.md`
   (claims hook, self-signup off, MFA TOTP, minimum password length).
2. **Migrations** with `scripts/db-remote.mjs` (migrations first, then code; never `db push`). No seed in production.
3. **Region of the database**, once, as the owner (migration login):
   `select core.set_deployment_region('<EU|US|JP>', 'regional deployment <region>, change <CR id>');`
   Check: `select core.deployment_region();` returns the region.
4. **Netlify site** `trialops-<region>` from the same repository and commit (Team login on until the app login is the only
   entry). Environment (server-side only): `DATABASE_URL` (pooler of the regional project), `TRIALOPS_JWKS_URL`,
   `TRIALOPS_OIDC_PRIVATE_JWK`, `TRIALOPS_DECISION_SIGNING_KEY`, `TRIALOPS_DEPLOYMENT_REGION=<EU|US|JP>`,
   `TRIALOPS_AI_PROVIDER_CODE=<code of the AI provider in core.service_provider>`; web build: `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_PUBLISHABLE_KEY` of the regional project. Secrets pass only by pipe between CLIs or from the Keychain.
5. **Service providers of the region** (CMP-08, `docs/compliance/PRIVACY_BY_DESIGN.md`): register and qualify hosting,
   database and AI provider with processing region = the deployment region and the agreements of that region (EU: DPA +
   SCC when needed; US: BAA for PHI; JP: APPI transfer basis); use them on each platform.
6. **Verification (IQ)**: `GET /v1/health` answers `region.deployment_region = <region>`, `database_region = <region>`,
   `ok: true`; `scripts/iq-check.mjs` against the site; a request for a platform id of another region answers 403
   `wrong_region` and appears in `GET /v1/region/refusals`.
7. **Release**: the promotion of `docs/compliance/RELEASE_PROMOTION.md` runs per region (same tag everywhere).

## 4. Moving a platform to another region

Not supported by design: a data region is set once (0026) and the database of a region refuses platforms of another one
(0028). Should a regulator or sponsor ever require it, it is a documented migration project (export with certified copies,
CMP-14, import into the target region, verification, decommissioning with retention), never a configuration change.

## 5. Current state (2026-10-19)

- The deployed demo (Supabase `dbhmlvqrwkurxgeeidko`, eu-central-1; Netlify `trialops`) is **not pinned** and holds the
  synthetic platform PLAT-001 with `data_region = 'US'` in an EU-hosted project. It is synthetic data, so no transfer of
  personal data happens; but the demo must stay unpinned (do not set `TRIALOPS_DEPLOYMENT_REGION` there, and do not call
  `core.set_deployment_region` on it), or PLAT-001 must be re-seeded in a US project. Decision for Luca (review note).
- First GxP release: hosting decision in `GCP_BY_DESIGN.md` §5 (US data for SURPASS → the US deployment first).
