# Change review — NFR-06 regions: one deployment per data region (EU, US, JP)

| Field | Value |
| --- | --- |
| Requirement | NFR-06 "Same code deployable in EU, US and Japan regions with data kept separate per region" (v1, GxP impact direct, risk high, assurance scripted; GDPR-44, APPI-TRANSFER, HIPAA-312) |
| Related | CMP-08 (data region per platform, provider residency, app residency: 0026), rule 15 of `CLAUDE.md` |
| Branch | `v1-regions-a11y-ui` (from `main` 529c18d) |
| Migration | `db/migrations/0028_regions.sql` (additive, idempotent) |
| New environment variables | `TRIALOPS_DEPLOYMENT_REGION` (EU, US, JP; empty = not pinned), `TRIALOPS_AI_PROVIDER_CODE` (code of the AI provider in `core.service_provider`) |
| Author | Claude Code (TrialOps development engine), 2026-10-19 |
| Human review | **Pending: Luca Emili** (required before merge, CLAUDE.md rule 9, risk high) — unsigned |
| Open decisions | §6 |

## 1. Design

Separation is **physical**: one Supabase project and one Netlify site per region, same code, no replication
(`docs/compliance/REGIONS.md`). The code adds three layers of checks so that a misconfiguration cannot mix regions:

1. **Database (0028).** `core.deployment` holds the region of the database: one row, inserted only by
   `core.set_deployment_region()` (owner, not granted to any API role), audited (`attach_std 'gxp'`), never updated
   (trigger) or deleted. The call is refused when the database already holds a platform of another region. Once set,
   `core.platform_region_in_deployment()` (trigger on `core.platform`) refuses a platform of another region and gives a
   new platform without region the region of the database. `core.platform_regions(ids)` returns id, code and region
   only (security definer, for the API gate).
2. **Platform API (`packages/api/src/lib/region.ts`).** `TRIALOPS_DEPLOYMENT_REGION` is validated at start-up. On every
   authenticated route, after authentication and the access policy:
   - the database region must equal the API region, otherwise 503 `region_misconfigured` (also when the database has a
     region and the API is not pinned);
   - every platform named by the request (`/v1/platforms/:id...`, `platform_id` in the query or the body) whose region is
     another one → 403 `wrong_region` with the region to use; the refusal is written by `core.log_region_refusal()` in its
     own transaction (the request is rolled back) into `core.region_access_refusal` (append-only, audited, actor and
     server time from the token and the clock);
   - the platform perimeter of the token (`platform_ids`) is narrowed to the platforms of the region before the request
     transaction starts, so the existing RLS (`core.can_see_platform`) hides every record of other regions on all the
     other routes. A token without `platform_ids` (sees all) is given the explicit list of the region's platforms.
   - Region of a platform is cached per process only once set (it is set once, 0026); unknown and unset are re-read.
   403 rather than 421 Misdirected Request: HTTP clients (undici, browsers) retry a 421 on a new connection, which would
   record every refusal twice (found by the tests).
3. **Apps and AI.** Catalogue entries carry `available_in_region`; `POST /v1/platforms/:id/apps` refuses a manifest whose
   `data_residency` does not cover the deployment region or the platform region (422 `residency_mismatch`; the database
   refuses it again at activation, 0026). The manifest schema now accepts `JP`. The AI runtime calls
   `core.provider_allowed(platform, TRIALOPS_AI_PROVIDER_CODE, category)` before any external model call with platform
   data (category from the data class: INTERNAL → operational, CONFIDENTIAL_SPONSOR → sponsor_confidential,
   CLINICAL_PSEUDONYMIZED → pseudonymised_clinical); a refusal is ledgered as `blocked` and the provider is not called.
   A pinned deployment without a provider code refuses every external call with platform data. The replay provider is
   local (nothing leaves the deployment) and is not checked.

Reporting: `GET /v1/health` (public) shows `region.deployment_region`, `database_region`, `ok`; `GET /v1/region` shows the
region and the platforms of the caller in it; `GET /v1/region/refusals` (QA auditor, platform admin; database guard
`core.audit_require_reviewer`) lists the refusals.

Not pinned (variable empty): local development, tests and the transitional demo keep today's behaviour (every platform of
the database is served). This is stated in REGIONS.md as not for GxP use.

## 2. Threats considered

| Threat | Control |
| --- | --- |
| EU code pointed at the US database (or the reverse) | API refuses to serve (503) when `core.deployment_region()` differs from `TRIALOPS_DEPLOYMENT_REGION` |
| Region variable forgotten on a regional site | A database with a region refuses an unpinned API (503); the IQ step of REGIONS.md checks `/v1/health` |
| Platform of another region created in a regional database (by seed, script or API) | Trigger on `core.platform` refuses it once the database has a region; setting the region refuses if one exists |
| Token or link that names a platform of another region | 403 `wrong_region`, recorded and audited; perimeter narrowed so no other route shows it |
| Participant data sent to an AI provider outside the region or without agreement | `core.provider_allowed` before the call; refusal ledgered; pinned deployment refuses an unregistered provider |
| App storing data outside the region | Installation refused by residency (API) and activation refused (database, 0026) |
| Refusal log altered | Append-only triggers, no grant to API roles, audit row per refusal |
| Tampering with the deployment region | Owner-only function, set once, audited, update/delete refused |

Residual: separation of the regional databases themselves (network, backups, support access) is a property of the
hosting providers and is covered by their qualification (CMP-05, `ASSESSMENT_VENDORS.md`), not by this code. A database
owner can still insert rows directly; the trigger on `core.platform` applies to the owner too, but other tables are not
region-checked individually (they carry `platform_id` and follow the platform).

## 3. Test evidence (scripted)

- `db/tests/regions.test.mjs` (4 tests): region set once by the owner, refused with a platform of another region, not
  settable or readable by API roles, audited; platforms of another region refused once set, default region for a new
  platform; `platform_regions` returns id/code/region only; refusal log append-only, audited, actor and server time,
  reviewer-only search.
- `packages/api/test/regions.test.ts` (5 tests): variable parsing and request platform detection; EU deployment refuses the
  US platform on path, query and body routes (403, recorded, audited, no write), narrowed perimeter (empty list, 404 on
  its arm, `/v1/me` without the platform); US deployment serves PLAT-001 and refuses an EU platform in the same database;
  503 on database/API region mismatch (pinned and unpinned); app residency in catalogue and installation (deployment and
  platform region), JP manifest accepted.
- `services/ai-runtime/test/residency.test.ts` (4 tests): provider not allowed → blocked, not called, ledgered; allowed →
  called with the right category; pinned without provider code → blocked; replay not checked; unpinned unchanged.
- `db/tests/migrations_idempotent.test.mjs`: 0028 applied twice more without schema change.
- Whole gate: `TRIALOPS_GATE=foundations,v0,gxp-p0 npm run verify` green on the branch (counts in the final report of the
  change; `test-results.xml`).

## 4. Not in scope

Provisioning of the EU/US/JP projects and sites (needs Luca's yes per action); synchronisation of accounts across regions;
per-region release orchestration (the promotion workflow runs per site); a UI page for the region (the values are in
`/v1/health` and `/v1/region`).

## 5. Rollback

Code: revert the commits of the branch (the API without the gate ignores the new tables). Database: 0028 is additive; the
new tables, functions and the trigger on `core.platform` can stay unused. To neutralise the trigger without dropping it,
leave `core.deployment` empty (no region set) — that is the state of every existing database after the migration.

## 6. Decisions for Luca

1. The deployed demo is an EU-hosted project (eu-central-1) holding a synthetic platform declared `US`. Keep the demo
   **unpinned** (proposed default, nothing to do), or re-create it as the US deployment?
2. Which hosting region and provider for the first GxP deployment (US for SURPASS, `GCP_BY_DESIGN.md` §5), and the AI
   provider code to register per region (`TRIALOPS_AI_PROVIDER_CODE`).
3. Confirm 403 `wrong_region` (with the region to use in the message) as the answer to a cross-region request.
