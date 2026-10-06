# TrialOps

Open source clinical operations platform for adaptive, seamless platform trials (ARPA-H SURPASS, Technical Area 3).
Working name. License: AGPL-3.0-only (see LICENSE). Runs on Supabase or plain PostgreSQL + PostgREST (docs/supabase.md).

**Status:** release *Foundations* — data model, audit trail, access control, task engine, app contract schemas,
synthetic demo data. No UI or HTTP API yet (next: demo v0).

## Quick start

```bash
npm install
npm run db:reset    # embedded PostgreSQL 17, applies db/migrations, loads demo seed "demo-plat-001"
npm test            # tests on a real PostgreSQL, writes test-results.xml
npm run trace       # docs/traceability.md: requirement -> test -> result
npm run verify      # lint (incl. AI-01 provider boundary) + typecheck + test + trace: the quality gate
```

TypeScript runs natively on Node ≥ 22.18 (type stripping): tests live in `db/tests/` and `<workspace>/test/`, all run by
`node --test` and tagged with requirement IDs. Set `TRIALOPS_GATE=foundations,v0` to make the trace step fail on a
release that is not fully covered yet.

No Docker needed for development: `embedded-postgres` downloads a PostgreSQL binary. Data lives in `.pgdata/`
(override with `TRIALOPS_PGDATA`, port with `TRIALOPS_PGPORT`, default 54329).

## Layout

| Path | Content |
| --- | --- |
| `db/migrations/` | Ordered SQL migrations — the domain model (spec §5) |
| `db/seed/seed-demo.mjs` | Deterministic synthetic data: PLAT-001, 3 arms + shared control, 6 sites, 240 subjects |
| `db/tests/` | Tests tagged with requirement IDs, e.g. `[DM-03]` |
| `packages/schemas/` | App manifest JSON Schema, event catalogue, reference manifest |
| `docs/requirements.json` | Requirement register by release |
| `docs/traceability.md` | Generated traceability matrix |
| `packages/api/` | Platform API (TypeScript, ARC-03) |
| `services/ai-runtime/` | AI runtime: the only component allowed to call AI providers (AI-01, ARC-10) |
| `scripts/` | DB runner, traceability generator, shared test-file discovery |

## What the foundations guarantee (all enforced in the database, not in the UI)

- **Audit trail** (CMP-01): every GxP insert/update writes `core.audit_event`, hash-chained; update/delete/truncate of
  the trail is blocked; `select core.audit_verify()` returns the first broken link or `null`.
- **Change control** (DM-03): updates need `set_config('trialops.change_reason', ...)`; physical deletes are refused,
  use `status = 'void'`.
- **Controlled versions** (DM-02): approved protocol/appendix versions are immutable; approval requires a signature.
- **Access** (IAM-02/03/04/07): row level security from JWT claims `platform_ids`, `arm_scopes`, `site_scopes`
  (`"*"` = all); arm allocation hidden from blinded users and from every agent; unblinded data only in `sac_enclave`.
- **Tasks** (APP-TK-02/04): state machine; GxP tasks executed by agents or apps must pass `waiting_review` and be
  completed by a person with a signature.
- **Apps** (APP-MF-01/02/04): manifest schema, approval grants scopes, uninstall revokes them.
- **Events** (APP-DT-04): domain events written to `core.event_outbox` in CloudEvents 1.0 shape.
- **Metrics** (M11-01/02): SURPASS TA3 catalogue; arm onboarding times computed from records, never typed.

## Specification

Source of truth: "Specifiche di sviluppo — Piattaforma TA3 Clinical Operations (demo-ready)", 2026-10-06.
