# Risk-based quality management and service provider oversight

Requirements: **CMP-05** (ICH E6(R3) data governance: critical-to-quality factors, RBQM, reconstruction of every decision
and adaptation, service provider oversight) and **VAL-04** (L2–L3 apps need the supplier validation package and passing
contract tests). Technical controls: migration `0026_quality_privacy_governance.sql`; API tags `quality`, `providers`,
`apps` in the OpenAPI document. This page is the procedure (SOP-level summary); the database enforces the rules below.

## 1. Critical-to-quality factors (CtQ)

- At platform set-up and at every new arm, the platform operations manager and QA record the CtQ factors
  (`POST /v1/platforms/{id}/ctq-factors`): what must go right for participant protection and reliable results
  (ICH E8(R1), E6(R3) §3.10). Categories: participant protection, data reliability, trial conduct, other.
- A factor is retired or voided, never deleted; every change carries a reason and is in the audit trail.

## 2. Risk register

- Each risk is linked to a CtQ factor and scored 1–5 for likelihood, impact and detectability (5 = hardest to detect);
  the score (product, 1–125) is computed by the database. Controls and owner role are mandatory.
- Status: open → mitigated / accepted / closed → (re)open; void ends it. Re-assessment and status changes need a reason
  (`PATCH /v1/quality-risks/{id}` with `X-Change-Reason`).
- Review: at least at every interim look of the platform and when a KRI/QTL is breached; `review_due` records the date.

## 3. Key risk indicators and quality tolerance limits

- A KRI or QTL measures a metric with a lower and/or upper limit. Built-in metrics computed from the records
  (`POST /v1/platforms/{id}/quality-limits/evaluate`): `deviation.major_per_100_randomized`, `subject.screen_failure_pct`,
  `sae.open_overdue`. Other metrics are recorded as manual observations by quality roles or the data manager.
- Subject-derived metrics are computed at platform level only: computing them per arm would need the allocation
  (blinding, rule 5).
- **Breach**: an observation outside the limits is flagged by the database, emits `quality.limit.breached` and opens a GxP
  task `rbqm.breach.review` for the platform operations manager (QTL: urgent; KRI: high). The review decides corrective
  action and, for QTL breaches, the reporting in the clinical study report (E6(R3)).
- Observations are append-only facts (value, source, author, server time).

## 4. Reconstruction of decisions and adaptations

`GET /v1/arms/{id}/decision-timeline` (QA auditors and platform admins) returns, in time order, everything that decided or
adapted an arm: audit-trail entries of arm-level records (with reasons), the signatures on them, AI requests and agent
decision records about the arm, and its domain events. Subject rows are never part of it (blinding). Inspectors use it
together with the audit trail review (CMP-10) and certified copies (CMP-14).

## 5. Service providers (ICH E6(R3) service providers, Annex 11 §3)

- Registry (`/v1/service-providers`): code, responsibilities delegated, data categories, processing regions, GxP relevance.
- Life cycle enforced by the database: **proposed → qualified** (needs a recorded qualification or audit that is not
  unsatisfactory) **→ active** (needs every required agreement in force, see PRIVACY_BY_DESIGN.md, a quality agreement
  when GxP-relevant, and a last oversight activity that is satisfactory and not overdue) **→ suspended / terminated**.
- Oversight activities (qualification, periodic review, audit, KPI review, incident review, requalification) are recorded
  with outcome and findings; the next review date = last activity + review interval (default 12 months). Overdue
  providers are flagged by `GET /v1/service-providers` and by the privacy check, and cannot be re-activated until reviewed.
- QA reviews the registry quarterly: overdue reviews, unsatisfactory outcomes (CAPA reference), expiring agreements.

## 6. Supplier validation of apps (VAL-04)

- For an L2 or L3 app version, QA receives the supplier validation package (`POST /v1/apps/validation-packages`: URI,
  SHA-256, contents) and reviews it (`POST /v1/app-validation-packages/{id}/review`, QA only, with a note). An accepted
  L2–L3 package contains at least URS, risk assessment, test evidence and traceability.
- Contract tests of the version against the TrialOps API contract are recorded as facts
  (`POST /v1/apps/contract-test-runs`); pass = no failure and at least one passed test.
- The database refuses to activate an L2–L3 installation unless the exact version has an accepted package from an
  **active** supplier and its latest contract test run passed; the package and the run are stamped on the installation
  (audited). `GET /v1/apps/{app_id}/validation` shows the gate. The app must also keep its data in the platform region.
