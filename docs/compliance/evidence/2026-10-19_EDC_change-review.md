# Change review — native EDC, wave D part 1 (EDC-01, EDC-03, EDC-04, EDC-05, EDC-11, EDC-12)

| Field | Value |
| --- | --- |
| Requirements | EDC-01 "Versioned CRF library linked to protocol visits" (direct, medium, scripted), **EDC-03 "Site data entry"** (direct, **high**, scripted), **EDC-04 "Declarative edit checks"** (direct, **high**, scripted), EDC-05 "Query workflow" (direct, medium, scripted), **EDC-11 "No arm data in blinded eCRF"** (direct, **high**, scripted), EDC-12 "visit.completed event and data-collection metric" (indirect, low, automated). Clauses in `docs/requirements.json` |
| Branch | `v1-edc` (from `main` 529c18d) |
| Migration | `db/migrations/0027_edc_native.sql` (additive, idempotent; not applied to any remote database) |
| Author | Claude Code (TrialOps development engine), 2026-10-19 |
| Human review | **Pending: Luca Emili** (required before merge, CLAUDE.md rule 9: EDC-03, EDC-04 and EDC-11 are risk high) |
| Signature | _not signed_ |

## 1. Design

The EDC is a module of the core (decision of 6 October 2026), so it is built with the same controls as every GxP table:
`core.attach_std` (audit with reason on every update, no physical delete), `platform_id`, RLS, state machines in the
database, server UTC time and author set by triggers (rule 11). The API (`packages/api/src/routes/edc.ts`) only shapes
requests and responses; every rule below is enforced by the database, so PostgREST or a future client cannot bypass it.

**Library (EDC-01).** `core.crf_form` (ODM FormOID, CDASH domain) → `core.crf_version` (draft → approved → superseded,
or draft → void) → `core.crf_item` (ODM ItemOID, CDASH variable, type `integer`/`decimal`/`text`/`date`/`coded`, unit,
required), `core.crf_edit_check`, `core.crf_visit` (link to `core.visit_definition`, the visits of an approved Master
Protocol version, with planned day, window and USDM encounter id). Units and coded values come only from
`core.codelist` / `core.codelist_term` (dictionary, dictionary version, submission value, decode, NCI code), approved and
then immutable (rule 13): a coded item needs an approved codelist of the platform, a unit must be a term of an approved
`UNIT` codelist, terms are append-only and added only while the codelist is a draft. A version is approved only with an
approval signature on that very version (`core.signature`, meaning `approval`, re-authentication with password and
authenticator code, CMP-02), never by a person who authored the version or any of its items, checks or visit links
(IAM-05, checked from the audit ledger), only with at least one item and one active visit, and only when every check
refers to items of the version. Approval supersedes the previous approved version in the same transaction and emits
`edc.crf.version.approved`. Items, checks and visit links of a non-draft version cannot be inserted or changed (DM-02).
Data already entered stays bound to the version it was entered with (`crf_entry.crf_version_id`).

**Data entry (EDC-03).** `core.subject_visit` (visit date checked against the server UTC date; only consented subjects;
one per subject and visit) → `core.crf_entry` (one per visit and form, current approved version, form must be scheduled at
that visit) → `core.item_value` (one per entry and item: canonical value plus typed `value_num`/`value_date`, or a
missing-data reason ND/NA/UNK, never both). Platform, site and subject are copied from the parent record, never taken from
the caller; `entered_by`/`entered_at` are the server's; `source` is `site_entry` or `app`. Only `site_pi` and
`study_coordinator` create visits and forms and enter or correct values (investigator control, EMA 2023 §4.6): a data
manager, a monitor, a sponsor or an agent cannot. A correction is an UPDATE: the audit trigger requires a reason (DM-03)
and keeps the old and new row; `core.item_value_history()` returns the prior values with author, server time and reason
to readers of the site data. Apps write values only with the scope `edc.data:write` on the platform and with provenance
(APP-DT-05, `core.stamp_provenance`).

**Edit checks (EDC-04).** Declared as rows of the CRF version: `required`, `range` (numeric), `compare` (two numeric or two
date items, operator `< <= > >= = <>`), each `soft` or `hard`, with the message shown to the site. `core.edc_evaluate()`
(security definer, deterministic: the same data always give the same result) runs after every value write (only the checks
that involve the item), at form completion (all checks) and in batch (`core.edc_run_checks`, data manager / monitor / site).
A failing **hard** check refuses the write or the completion; a failing **soft** check opens one query per check and form
(never a duplicate); a check that passes after a data change closes its open queries with the reason "Resolved by data
change" (audited, attributed to the person whose change resolved it). Missing values (ND/NA/UNK) satisfy `required` and
make `range`/`compare` not evaluable.

**Queries (EDC-05).** `core.edc_query`: `open → answered → closed`, `open → closed | cancelled`, `answered → open`
(re-query; the previous answer stays in the audit trail); closed and cancelled are terminal. Origin `edit_check` (only the
evaluation function can open these) or `manual` (data manager or monitor). The site answers; data managers and monitors
close, cancel or re-query, always with a reason. Subject, item, question and opening are immutable; the times of every step
are the server's (metrics). No delete.

**Blinding (EDC-11, rule 5).** No EDC table, view or function has an arm column, a foreign key to `core.arm` or reads the
allocation; visit definitions and CRFs are platform level; the API reads subjects only through `core.subject_blinded`
with an explicit column list; `visit.completed` carries `arm_id = null` and no arm field; the data collection metric is
platform level only. Reading subject-level EDC data needs a clinical-operations role (`core.edc_clinical_reader`): sponsors
(`arm_sponsor_lead`, perimeter = an arm) do not read it, because splitting subject data by arm would reveal the allocation.
Agents do not read or write EDC data in this release.

**visit.completed and metric (EDC-12).** Completing a visit needs every CRF scheduled at that visit complete; the trigger
stamps `completed_at` and emits `visit.completed` with visit date, completion time and days to data. The view
`core.v_visit_data_collection` gives the same days per visit; `TA3-DATA-COLLECT` (target ≤ 2 days) is their mean, with
drill-down to the visits and their events (M11-02).

## 2. Database changes (0027)

New tables (all with `platform_id`, RLS policy `scope`, audit): `codelist`, `codelist_term` (append-only: audit insert +
immutable trigger), `visit_definition`, `crf_form`, `crf_version`, `crf_item`, `crf_edit_check`, `crf_visit`,
`subject_visit`, `crf_entry`, `item_value` (with the four APP-DT-05 provenance columns), `edc_query`; view
`v_visit_data_collection` (security barrier). Functions: guards and integrity triggers per table, `edc_evaluate`,
`edc_check_passes`, `edc_run_checks`, `item_value_history`, helpers (`edc_clinical_reader`, `edc_claims_allow`,
`edc_app_scope`, `edc_site_staff`, `edc_today`, `edc_api_caller`, `edc_reader_roles`).
Grants: select/insert/update to `authenticated` on the new tables (select/insert on `codelist_term`); `app_service` reads
definitions, visits and entries and writes `item_value` only; nothing to `anon`; no DELETE anywhere. `REVOKE` only on the
new objects (to remove default privileges) and execute on the new functions revoked from `public`, then granted as needed.
No change to existing tables, grants or policies; no DROP, DELETE or TRUNCATE.

## 3. Threats considered

| Threat | Control |
| --- | --- |
| Edit of an approved CRF changes the meaning of collected data | Version FSM; integrity trigger freezes items, checks and visits of non-draft versions; data bound to its version |
| Approval by the author, by a non-person, or with a signature of something else | Signature target, meaning and SoD checked by the database; API requires person + re-authentication |
| Free-text terminology | Coded items and units only from approved, versioned codelists; values checked against the terms |
| Sponsor or CRO modifies site data | Only site roles write values; DB guard independent of the API |
| Back-dated or caller-supplied times | `entered_at`, `opened_at`, `answered_at`, `closed_at`, `completed_at` set by triggers; visit date not in the future (UTC) |
| Silent overwrite of a value | UPDATE requires a reason; old/new row in the hash-chained audit trail; history endpoint |
| Edit check bypassed by a direct write | Checks run in an AFTER trigger on every write path (API, PostgREST, app) |
| Query closed by the site, or reopened after closure | FSM with role checks; closed/cancelled terminal |
| Unblinding through the eCRF | No arm in the EDC schema, API or events; sponsors excluded from subject-level EDC data; scripted tests over schema, function bodies, rows and API responses |
| App writes without traceable origin | Scope `edc.data:write` and mandatory provenance (APP-DT-05) |
| Cross-site access | RLS by platform and site; definer functions check the token perimeter (`edc_claims_allow`) |

Residual: a database owner can still change data (as for every table; detectable through the audit seal, CMP-12). The
evaluation function opens and closes queries with the owner's rights by design; it is reachable only within the caller's
perimeter.

## 4. Test evidence (scripted)

- `db/tests/edc.test.mjs` (21 tests): library versioning, linking and immutability; approval signature, SoD and supersession;
  terminology controls; server-stamped author/time and parent-derived perimeter; typing, codelists, ND/NA/UNK; change with
  reason and history; site-only writes, investigator access, other sites and sponsors excluded; app scope and provenance;
  visit rules; soft/hard/compare/required checks, auto-closure, deterministic batch; query FSM, roles, re-query, cancel,
  audit; blinding over schema, function bodies, rows of every EDC relation for blinded users and agents, events;
  visit.completed and the metric view.
- `packages/api/test/edc.test.ts` (7 tests): library and version detail; approval through the API (SoD, roles, supersession,
  frozen version, new draft); data entry with hard/soft checks; query workflow; correction with reason and history;
  visit completion, event and `TA3-DATA-COLLECT` with drill-down; no arm in any EDC response.
- `apps/web/test/edc_pages.test.ts` (5 tests): page codes TRO-070…075, routes and navigation; strings in one place per page;
  no allocation in the pages; signature dialog and manifestation; reason for changes; UTC times.
- `db/tests/migrations_idempotent.test.mjs`: 0027 applied twice more on the seeded copy without schema change;
  `db/tests/compliance.test.mjs` (CMP-15 audit coverage, APP-DT-05 provenance) and DM-01 cover the new tables.
- `e2e/demo-v0.spec.ts`: the site PI starts a Week 12 visit, enters a systolic value of 270 mmHg, the soft range check opens
  a query, the PI answers it (screens `07-edc-query-opened`, `08-edc-query-answered`).
- Gate run on 2026-10-19: `TRIALOPS_GATE=foundations,v0,gxp-p0 npm run verify` green, 342 tests, 0 failures; traceability
  0 tagging errors; EDC-01, EDC-03, EDC-04, EDC-05, EDC-11, EDC-12 PASS in `docs/compliance/compliance-matrix.md`.

## 5. Not in scope (later requirements)

EDC-02 (eCRF per arm and stage; needs its own blinding design), EDC-06 (SDV and reviews), EDC-07 (PI signature of forms
and casebook), EDC-08 (locks and data freeze), EDC-09 (ODM / Dataset-JSON export), EDC-10 (lab/EHR import), conditional
fields and derived values of EDC-03, a UI to edit draft CRF items and checks (API only today), Japanese strings (the
pages keep their strings in one object per page for the i18n mechanism), agent-proposed queries (M06-03).

## 6. Decisions for Luca

1. Sponsors (`arm_sponsor_lead`) do not read subject-level EDC data in v1 (default taken to protect blinding). Confirm, or
   decide the aggregate/blinded view sponsors should get.
2. Agents neither read nor write EDC data in v1. Confirm before an EDC agent (e.g. query proposals) is designed.
3. Who may reopen a completed visit: today the site (with reason). Alternative: data manager approval.
4. The demo codelists are a synthetic subset (NCI codes only for No/Yes); a real trial loads the licensed CDISC CT version.
5. Remote demo: apply 0027 (additive) and run `node scripts/backfill-demo-edc.mjs --dry-run` then without `--dry-run`.
