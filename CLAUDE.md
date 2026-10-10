# Instructions for the development engine (Claude Code / Forge / Local Dev)

Read this before changing anything. The specification is `docs/SPEC.md` (Markdown export of the shared doc
"Specifiche di sviluppo — Piattaforma TA3 Clinical Operations"). It is the source of truth; requirement IDs come from it.
If `docs/SPEC.md` is missing, stop and ask for it.

## Non-negotiable rules
1. **Every change is traced.** Each new test name starts with the requirement IDs it covers: `test('[M01-02] ...')`.
   Add new requirements to `docs/requirements.json` with their release. `npm run verify` must pass.
2. **Never weaken GxP controls to make something work.** Do not disable audit triggers, RLS, the task state
   machine or the immutability triggers. If a feature seems to need it, stop and ask.
3. **No physical deletes, no edits to approved versions.** Use `status='void'` and new versions.
4. **Schema changes only through new migration files** (`db/migrations/NNNN_name.sql`), never edit an applied one
   after it reached `main`. Every GxP table: `select core.attach_std('core.<table>')`, `platform_id`, RLS policy.
5. **Blinding:** never add `arm_id` of subjects to anything an authenticated (blinded) user or an agent can read.
6. **AI:** no direct provider calls from modules or apps. Everything goes through the AI runtime (`POST /api/ai/tasks`)
   and is recorded in `core.ai_request`. Provider for the demo: Anthropic via API. GxP outputs are proposals.
7. **Demo data is synthetic only.** Never load real patient, sponsor or financial data in dev/test/demo.
8. **Secrets** live only server-side (Key Vault / env), never in the frontend or the repo.

## GCP by design (US / EU / Japan) — `docs/compliance/GCP_BY_DESIGN.md`
9. **Every requirement declares its compliance profile** in `docs/requirements.json`: `gxp_impact` (direct/indirect/none),
   `risk` (high/medium/low), `assurance` (scripted/automated/unscripted, FDA CSA) and `regs` (clause codes from
   `docs/compliance/crosswalk.json`). Write it before the code. `risk: high` needs scripted tests with recorded evidence
   and a human review of the change before merge. `npm run trace` regenerates `docs/compliance/compliance-matrix.md`.
10. **Every new table or state change is audited.** New tables in `core`/`sac_enclave` get `core.attach_std` (or the
    append-only trigger); an exception goes in `NOT_AUDITED` of `db/tests/compliance.test.mjs` with a reason an
    inspector would accept. State changes only through the database state machines.
11. **Time is the server's UTC.** Never accept client timestamps in GxP records; the UI shows the time zone.
12. **Every GxP AI task type has a credibility plan** (`docs/ai/<task_type>.md`: question, context of use, model
    influence, decision consequence, test dataset, metrics, thresholds) before it is registered, and a dated model id.
13. **No clinical terminology as free text** (MedDRA, WHODrug, CDISC CT): versioned dictionary tables.
14. **Every export of a GxP record carries its audit trail and the signature manifestation** (name, UTC time, meaning).
15. **Regions and languages:** data stays in its region (EU, US, JP); site- and subject-facing pages are localisable
    (English and Japanese). Retention follows the platform policy (default 25 years, EU CTR art. 58).

## Quality gate (same as Forge)
`npm install && npm run db:reset && npm run verify` — lint (incl. the AI-01 provider boundary), typecheck, build, all
tests green, traceability with 0 missing for the release (`TRIALOPS_GATE=foundations,v0` at release time), 0 errors
in the compliance fields. The P0 GCP controls are release `gxp-p0` (gate it with `TRIALOPS_GATE=foundations,v0,gxp-p0`
once done).

## UI
Design direction C, chosen by Luca: follow `docs/DESIGN.md`. Pages use only `@trialops/shell` components and tokens.

## Decisions (2026-10-06)
New monorepo · Supabase for now (no Azure dependency) · existing IST user-management component (Supabase Auth) with
the custom access token hook in 0007 · typed tables for clinical data · Deontos out of scope (internal minimal policy
engine) · Anthropic API · license AGPL-3.0-only · EDC developed in-house as native module M06b · name "TrialOps"
provisional. See docs/supabase.md.

## Next release: demo v0 (target 4 Nov 2026)
Platform API (TypeScript) with OIDC, web shell (from Grant OS), platform dashboard, new-arm wizard with AI agents
(Protocol author, Onboarding planner), app catalogue with install + SSO of the TA1 test app.
Then v1 starts the native EDC (EDC-01, 03, 04, 05, 11, 12).
