# Wave D integration (native EDC + regions, a11y and governance UI): change review and SQL diff

| Field | Value |
| --- | --- |
| Branch | `v1-wave-d` (from `main` 529c18d), pushed to `origin/v1-wave-d` |
| Merged | `origin/v1-edc` (f776271, wave D part 1: EDC-01/03/04/05/11/12) and `origin/v1-regions-a11y-ui` (cc40641: NFR-06, NFR-07, AI-07, AI-10, CMP-05, CMP-08, VAL-04 UI) |
| Author | Claude Code (TrialOps development engine), 2026-10-19 |
| Human review | **Pending: Luca Emili** — unsigned. Reviews of the parts: `2026-10-19_EDC_change-review.md`, `2026-10-19_NFR-06_change-review.md`, `2026-10-19_NFR-07_a11y.md` |
| Database | Two new migrations, `0027_edc_native.sql` and `0028_regions.sql`, unchanged by the integration. **Not applied to the remote demo** |

## 1. Commits

From `v1-edc`: 5eddeae (compliance profiles before the code), 477bc69 (0027 schema), 8d9859e (synthetic EDC seed), ca6abc2 (API
routes), cc15056 (pages TRO-070…075), f9df5bf (e2e EDC step, backfill script), 3bdf2ba (EDC change review), f776271 (trace).

From `v1-regions-a11y-ui`: 0f0c55d (NFR-06 regions, 0028), ce08e2b (NFR-07 i18n), 26011b1 (governance UI TRO-052…057), fa394c1
(a11y fixes), 70ea5a1 (axe e2e, governance UI e2e), cc40641 (trace).

Integration:

| Commit | What |
| --- | --- |
| 3299c26 | Merge `v1-edc` (no conflict) |
| 77faa04 | Merge `v1-regions-a11y-ui`. Conflicts: `apps/web/src/App.tsx` (imports, navigation, page map: both kept; a duplicated `changeRequests` key removed in 9571806), `docs/compliance/GCP_BY_DESIGN.md` (EDC row of the investigator access kept, NFR-06 and NFR-07 rows added), `compliance-matrix.md` and `traceability.md` (taken and regenerated). `router.ts`, `pageCodes.ts` (TRO-052…057 and TRO-070…075 both kept), shell, `pages.test.ts`, `demo-v0.spec.ts`, `package.json`/lock merged automatically |
| 9571806 | NFR-07 on the EDC pages: `const T = (t) => ({…})` per file with every text through `t()`, record states, data types and check kinds translated, ~140 Japanese entries in `apps/web/src/i18n/ja.ts` (machine-drafted, same review flag), files listed in `SITE_FACING_PAGES`, DataTable `label` on the EDC tables, EDC routes in `e2e/a11y.spec.ts`. NFR-06: new API test that EDC data follows the region gate |
| 7213daa | Trace regenerated; NFR-07 note and GCP_BY_DESIGN updated for the EDC pages |

Not translated by design: CRF content (form names, item labels, codelist decodes, query questions and answers) and the
default reason of the CRF approval signature (recorded in the audit trail, CMP-11).

## 2. Regions and EDC data (NFR-06 × EDC)

The region gate (`packages/api/src/lib/region.ts`) needed no change. The EDC list routes are `/v1/platforms/:id/…`
(`crf-forms`, `edc/subjects`, `edc-queries`, `visit-definitions`, `codelists`): a platform of another region is refused
(403 `wrong_region`, recorded in `core.region_access_refusal`). The EDC routes addressed by record id (`/v1/edc/subjects/:id`,
`/v1/subject-visits/:id`, `/v1/crf-versions/:id`, `/v1/crf-entries/:id/…`, `/v1/edc-queries/:id/…`) carry no platform
parameter: they are covered by the narrowed `platform_ids` of the token, which the 0027 RLS policies
(`core.can_see_platform`) and the security definer EDC functions (`core.edc_claims_allow`) both read. Test
`[NFR-06][EDC-03][EDC-05] EDC data follows the region` (`packages/api/test/regions.test.ts`): on an EU deployment the five list
routes of the US platform answer 403, the three id routes 404, a value write and a query answer are refused with nothing
written; the US deployment serves the same data (200).

## 3. Results

| Check | Result |
| --- | --- |
| `npm run verify` with `TRIALOPS_GATE=foundations,v0,gxp-p0` (migrations check, lint, typecheck, build, tests, trace) | **green: 365 tests, 365 pass, 0 fail** |
| `npm run trace` | 93 requirements, 358 tests, 365 results; gate not passing: 0; foundations 27/27, v0 10/10, v1 28/38, v2 1/10, gxp-p0 8/8; tagging errors 0; compliance: 85 clauses, 0 requirement errors |
| `npm run e2e` (port 54382) | **3 / 3 green**: demo v0 end to end incl. the EDC step (7.0 s), a11y (1.7 min), governance UI (1.6 s) |
| axe WCAG 2.1 A/AA + layout | **0 violations on 112 page checks** (28 routes incl. the 6 EDC routes × en/ja × 1440/375 px), 0 pages with horizontal scroll, `lang` correct on all 112 |

The first `verify` run had one failure unrelated to the change (`[IAM-01] TRIALOPS_MFA=off`, `fetch failed: other side closed`
on an ephemeral port that collided with the Postgres port); the re-run was green with no change.

## 4. SQL diff for review

Full text: `git diff 529c18d v1-wave-d -- db/migrations` (2 new files, 1175 lines added, nothing changed in existing
migrations). Both are additive and idempotent. Statements that touch privileges, RLS or run as owner:

### 0027_edc_native.sql (EDC-01/03/04/05/11/12)

New objects only: 12 tables (`codelist`, `codelist_term`, `visit_definition`, `crf_form`, `crf_version`, `crf_item`,
`crf_edit_check`, `crf_visit`, `subject_visit`, `crf_entry`, `item_value`, `edc_query`), 1 view
(`v_visit_data_collection`, `security_barrier`, filters with `can_see_platform`, `can_see_site`, `edc_clinical_reader`), helper,
integrity and state-machine functions, triggers on the new tables only. Every table has `core.attach_std` (audit) or the
append-only triggers (`codelist_term`). It emits two new event types into the existing `core.event_outbox` through
`core.emit` (`visit.completed`, `edc.crf.version.approved`). No `ALTER` of an existing table, no `DROP`, `DELETE` or
`TRUNCATE`, no redefinition of an existing function.

**SECURITY DEFINER** (all with `set search_path = core, public`):

| Function | Why owner rights | Perimeter check |
| --- | --- | --- |
| `edc_app_scope(uuid, text)` | `app_service` cannot read app installations | reads only the token's `app_id` |
| `crf_version_integrity()` (trigger) | reads signatures and the audit ledger for separation of duties (author cannot approve) | trigger on the caller's own write |
| `edc_check_passes(crf_edit_check, uuid)` | reads the values of the entry being checked | called only by `edc_evaluate` |
| `edc_evaluate(uuid, text, text)` | opens/closes queries with `origin = 'edit_check'`, which API callers cannot insert | `edc_claims_allow(platform, site)` from the token, else `insufficient_privilege` |
| `item_value_checks()` (trigger) | calls `edc_evaluate` after a value write | as above |
| `item_value_history(uuid)` | reads `core.audit_event` | `edc_claims_allow`, else `insufficient_privilege` |

`edc_claims_allow` lets an empty JWT (`core.jwt() = '{}'`) through: that is the owner context (migrations, seed). Every API
and PostgREST request carries claims, so an API caller never reaches that branch.

**RLS** (`enable row level security` + policy `scope`):

- definitions (8 tables): `using / with check (core.can_see_platform(platform_id))`;
- clinical data (`subject_visit`, `crf_entry`, `item_value`, `edc_query`): `using (can_see_platform(platform_id) and
  can_see_site(site_id) and edc_clinical_reader(platform_id))`, `with check (can_see_platform(platform_id) and
  can_see_site(site_id))`. The role rules of writes (site staff enter, data manager/CRA open/close queries) are in the
  integrity and FSM triggers, not in `with check`.

**REVOKE / GRANT**:

```sql
revoke all on <12 new tables>, core.v_visit_data_collection from public, anon, authenticated, app_service, unblinded;
grant select, insert, update on <11 tables, not codelist_term> to authenticated;          -- no delete (DM-03)
grant select, insert on core.codelist_term to authenticated;                              -- terms are append-only
grant select on <definitions>, core.subject_visit, core.crf_entry to app_service;
grant select, insert, update on core.item_value to app_service;                           -- guarded by edc.data:write scope + provenance
grant select on core.v_visit_data_collection to authenticated, app_service;
revoke execute on function <all 23 new functions> from public;
grant execute on function edc_api_caller, edc_app_scope, edc_reader_roles, edc_clinical_reader, edc_claims_allow,
  edc_today, edc_site_staff to authenticated, app_service;                                 -- used inside policies/triggers
grant execute on function core.edc_evaluate(uuid, text, text) to authenticated, app_service;
grant execute on function core.edc_run_checks(uuid), core.item_value_history(uuid) to authenticated;
```

Nothing is granted to `anon`. No existing grant or policy is changed.

### 0028_regions.sql (NFR-06)

New tables `core.deployment` (one row, set once; audited, no update, no truncate) and `core.region_access_refusal`
(append-only, audited). One new trigger on an **existing** table: `region_in_deployment` before insert or update of
`data_region` on `core.platform` (preceded by `drop trigger if exists region_in_deployment` for idempotency: the only
`DROP` of the two files, on its own trigger).

**SECURITY DEFINER**: `deployment_region()`, `set_deployment_region(text, text)`, `platform_regions(uuid[])`,
`log_region_refusal(...)`, `region_refusal_search(int)` (this one calls `core.audit_require_reviewer()`: QA auditors and
platform admins only).

**REVOKE / GRANT**:

```sql
revoke all on core.deployment from public, anon, authenticated, app_service;
revoke all on core.region_access_refusal from public, anon, authenticated, app_service;
revoke execute on function <the 7 new functions> from public;
grant execute on function core.deployment_region() to anon, authenticated, app_service;    -- returns only EU/US/JP or null
grant execute on function core.platform_regions(uuid[]), core.log_region_refusal(...) to authenticated, app_service;
grant execute on function core.region_refusal_search(int) to authenticated;
-- core.set_deployment_region: owner only (no grant)
```

No RLS change (the new tables have no API grant; they are read and written through the functions).

**Point for the reviewer:** `core.platform_regions(null)` returns id, code and region of **every** non-void platform to any
authenticated caller (no title or data). The gate needs it before it narrows the perimeter; in a regional database all
platforms are of that region by construction. Accept, or restrict to the caller's `platform_ids` in a later migration.

## 5. Rollback plan

Migrations are never dropped (rule 4). If 0027 or 0028 misbehaves on the remote demo, the rollback is **code only**: redeploy
`main` at 529c18d; the new tables, functions and the trigger stay in the database, unused.

**The claim was checked.** In a throw-away worktree at 529c18d (the old code), 0027 and 0028 were added to the migrations
and the database was built and seeded as the remote demo would be (old seed, then the EDC rows, then the old test suite run
against it): **309 of 310 old tests pass**. The only failure is `[DM-01] every clinical table carries platform_id`, a schema
inventory test of the old code that does not know the new table `core.deployment` (the new code lists it among the
exempt tables) — a test artefact, not a runtime break. All old API, web and database behaviour tests pass with the new
schema and the EDC data present.

Why the old code is unaffected:

- 0027 adds only new objects; the old code never reads them. The two new event types in `core.event_outbox` are ignored
  by the old code (the old tests that read events pass).
- 0028's trigger on `core.platform` returns immediately while `core.deployment` is empty (`core.deployment_region()` is
  null). The demo database is **not** given a region: it stays the transitional, unpinned demo (REGIONS.md), and the
  Netlify site must keep `TRIALOPS_DEPLOYMENT_REGION` unset. Even with a region set, the trigger only fills the region of a
  new platform or refuses a platform of another region; the old code does not call any 0028 function.
- New code on a database without 0028 still starts when unpinned (the gate tolerates a missing `deployment_region()`,
  error 42883), but the EDC routes need 0027: **migrations before the deploy**.

If EDC data written on the remote demo were wrong: it is synthetic; correct it through the API with a reason (no physical
delete, rule 3), or void the records. A data defect in 0027 logic is fixed by a new migration (`0029_…`), never by editing
0027.

## 6. EDC backfill (`scripts/backfill-demo-edc.mjs`)

- **Idempotent**: exits with "already present, nothing to do" when `F.VS` exists on PLAT-001; refuses when 0027 is not
  applied or PLAT-001 is missing; everything in one transaction (rollback on any error).
- **Dry run**: `--dry-run` does the whole backfill and rolls it back, printing the counts.
- **Checked locally** on a database seeded with the old seed and migrated to 0028: dry run → counts printed, nothing written
  (audit 556 → 556); real run → 3 CRF versions, 22 values, 4 queries, 3 `visit.completed` (audit 556 → 666, events 132 →
  137, the same totals as a fresh seed); second run and a later dry run → "nothing to do", no change.
- The seed needs three subjects of site 101 on treatment (`seed-edc.mjs`); if demo use changed them, the dry run fails with
  that message and nothing is written.

## 7. Commands for the remote demo (NOT run)

Supabase project `dbhmlvqrwkurxgeeidko`, transaction pooler port 6543, DB password from the Keychain (same pattern as
`scripts/create-admin.sh`). `scripts/db-remote.mjs migrate` applies **every** pending migration of the checked-out tree, each
in its own transaction, stopping at the first failure. Run `status` first: it must list exactly the expected pending files.

```bash
cd /Users/lucaemili/Documents/trialops-wt/v1-wave-d && export DATABASE_URL="postgresql://postgres.dbhmlvqrwkurxgeeidko:$(security find-generic-password -s 'Supabase DB TrialOps (InSilicoTrials, eu-central-1)' -w)@aws-1-eu-central-1.pooler.supabase.com:6543/postgres" && node scripts/db-remote.mjs status
```

Expected: `pending 2: 0027_edc_native.sql, 0028_regions.sql` (if more is pending, stop and check). Then, in the same shell:

1. Migration 0027 and 0028 (one command, 0027 first, then 0028):
   ```bash
   cd /Users/lucaemili/Documents/trialops-wt/v1-wave-d && node scripts/db-remote.mjs migrate
   ```
   To apply 0027 alone first, run the same `migrate` from the `v1-edc` tree, which has no 0028:
   `cd /Users/lucaemili/Documents/trialops-wt/v1-edc && node scripts/db-remote.mjs migrate`, then the command above.
2. EDC backfill, dry run then real:
   ```bash
   cd /Users/lucaemili/Documents/trialops-wt/v1-wave-d && node scripts/backfill-demo-edc.mjs --dry-run
   ```
   ```bash
   cd /Users/lucaemili/Documents/trialops-wt/v1-wave-d && node scripts/backfill-demo-edc.mjs
   ```
3. Check: `node scripts/db-remote.mjs status` → `pending 0`. Do **not** call `core.set_deployment_region` on the demo database.

Then deploy the code (after the merge to `main`), and `unset DATABASE_URL`.

## 8. Open points

1. Human review of this change before the merge to `main` (EDC-03, EDC-04 and EDC-11 are `risk: high`, rule 9).
2. Native-speaker review of the Japanese catalogues, now including the EDC terms (症例報告書, 来院, 欠測, クエリ, エディットチェック).
3. `core.platform_regions` visibility of platform codes (§4).
4. Manual a11y pass (screen reader, 200% zoom, Japanese IME in the EDC forms), as in the NFR-07 note.
