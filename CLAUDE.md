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

## Quality gate (same as Forge)
`npm install && npm run db:reset && npm run verify` — lint (incl. the AI-01 provider boundary), typecheck, build, all
tests green, traceability with 0 missing for the release (`TRIALOPS_GATE=foundations,v0` at release time).

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
