# Traceability matrix

Generated 2026-10-17T13:02:52.398Z by scripts/trace.mjs from test tags and test-results.xml.

| Requirement | Release | Description | Tests | Result |
| --- | --- | --- | --- | --- |
| CMP-01 | foundations | Append-only, hash-chained audit trail; tampering detectable | db/tests/audit.test.mjs (3) | PASS |
| CMP-02 | foundations | Part 11 e-signatures: immutable, linked to signed version | db/tests/audit.test.mjs, db/tests/protocol_arms.test.mjs, packages/api/test/protocol_arms.test.ts, packages/api/test/wizard.test.ts (5) | PASS |
| CMP-04 | foundations | ALCOA+: who/when/old/new/reason captured on every GxP change | db/tests/audit.test.mjs (1) | PASS |
| DM-01 | foundations | Every clinical entity carries platform_id (+ arm_id, site_id) | db/tests/protocol_arms.test.mjs (1) | PASS |
| DM-02 | foundations | Approved controlled versions are immutable; approval needs signature | db/tests/protocol_arms.test.mjs, packages/api/test/protocol_arms.test.ts (4) | PASS |
| DM-03 | foundations | Change reason mandatory on GxP updates; no physical delete | db/tests/audit.test.mjs, db/tests/sites_registry.test.mjs (4) | PASS |
| DM-05 | foundations | Deterministic synthetic demo seed; no real data | db/tests/tasks_apps_metrics.test.mjs (1) | PASS |
| IAM-02 | foundations | RLS driven by JWT claims platform_ids / arm_scopes / site_scopes | db/tests/access.test.mjs, db/tests/claims.test.mjs, db/tests/sites_registry.test.mjs, packages/api/test/apps_sso.test.ts, packages/api/test/platform.test.ts, packages/api/test/sites.test.ts (11) | PASS |
| IAM-03 | foundations | Sponsors see and write only their own arm | db/tests/access.test.mjs, packages/api/test/ai.test.ts, packages/api/test/metrics.test.ts, packages/api/test/platform.test.ts, packages/api/test/protocol_arms.test.ts (6) | PASS |
| IAM-04 | foundations | Unblinded data only in sac_enclave for the unblinded role | db/tests/access.test.mjs, db/tests/claims.test.mjs (3) | PASS |
| IAM-05 | foundations | Separation of duties: the author of a GxP document or change cannot approve it | packages/api/test/protocol_arms.test.ts, packages/api/test/wizard.test.ts (2) | PASS |
| IAM-07 | foundations | Agents are never unblinded | db/tests/access.test.mjs, packages/api/test/jobs.test.ts, packages/api/test/platform.test.ts, packages/api/test/wizard.test.ts (4) | PASS |
| AI-05 | foundations | GxP AI output is a proposal until a person signs | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/ai.test.ts, packages/api/test/protocol_arms.test.ts, packages/api/test/wizard.test.ts (8) | PASS |
| AI-06 | foundations | AI ledger with model version and input hash | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/ai.test.ts, packages/api/test/jobs.test.ts, services/ai-runtime/test/runtime.test.ts (7) | PASS |
| AI-11 | foundations | AI never sees unblinded data outside the SAC enclave | db/tests/access.test.mjs, services/ai-runtime/test/runtime.test.ts (2) | PASS |
| APP-MF-01 | foundations | App manifest validated against published JSON Schema | db/tests/schemas.test.mjs, packages/api/test/apps_sso.test.ts (5) | PASS |
| APP-MF-02 | foundations | App activation requires approval; scopes granted on approval | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/apps_sso.test.ts (2) | PASS |
| APP-MF-04 | foundations | Uninstall revokes scopes | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/apps_sso.test.ts (2) | PASS |
| APP-TK-02 | foundations | Task state machine with logged transitions | db/tests/tasks_apps_metrics.test.mjs (1) | PASS |
| APP-TK-04 | foundations | GxP tasks by agents/apps pass waiting_review + signature | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/wizard.test.ts (4) | PASS |
| APP-DT-04 | foundations | Domain events in CloudEvents 1.0 via outbox | db/tests/protocol_arms.test.mjs, db/tests/schemas.test.mjs (2) | PASS |
| M01-04 | foundations | Arm lifecycle with allowed transitions and events | db/tests/protocol_arms.test.mjs, packages/api/test/protocol_arms.test.ts (5) | PASS |
| M05-02 | foundations | Enrollment funnel per site (blinded) | db/tests/tasks_apps_metrics.test.mjs (1) | PASS |
| M07-01 | foundations | SAE expedited reporting clock | db/tests/protocol_arms.test.mjs (1) | PASS |
| M11-01 | foundations | SURPASS TA3 metric catalogue with targets | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/metrics.test.ts (2) | PASS |
| M11-02 | foundations | Arm onboarding metrics computed from records | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/metrics.test.ts (4) | PASS |
| APP-ID-01 | v0 | OIDC SSO via identity broker | packages/api/test/apps_sso.test.ts (3) | PASS |
| APP-ID-02 | v0 | Access token carries sub, email, org_id and TrialOps claims platform_ids, arm_scopes, roles, blinding | db/tests/claims.test.mjs, db/tests/sites_registry.test.mjs, packages/api/test/apps_sso.test.ts, packages/api/test/platform.test.ts (10) | PASS |
| APP-ID-02 | foundations | TrialOps claims (platform/arm/site scopes, blinding) added to the Supabase token | db/tests/claims.test.mjs, db/tests/sites_registry.test.mjs, packages/api/test/apps_sso.test.ts, packages/api/test/platform.test.ts (10) | PASS |
| AI-01 | v0 | All AI calls through POST /api/ai/tasks | packages/api/test/ai.test.ts, packages/api/test/jobs.test.ts, services/ai-runtime/test/boundary.test.ts, services/ai-runtime/test/runtime.test.ts (10) | PASS |
| M01-01 | v0 | Structured Master Protocol / appendix editor | packages/api/test/protocol_arms.test.ts (2) | PASS |
| M01-02 | v0 | New-arm wizard with AI-drafted appendix and task plan | packages/api/test/jobs.test.ts, packages/api/test/wizard.test.ts (5) | PASS |
| M02-01 | v0 | Site registry | db/tests/sites_registry.test.mjs, packages/api/test/sites.test.ts (6) | PASS |
| M02-03 | v0 | Per-arm site activation workflow | packages/api/test/sites.test.ts (3) | PASS |
| APP-TK-01 | v1 | Task model and inbox | — (0) | NO TEST |
| APP-TK-03 | v1 | Apps claim and close tasks via API | — (0) | NO TEST |
| AI-07 | v1 | Tool registry AUTO/CONFIRM/BLOCK | — (0) | NO TEST |
| AI-08 | v1 | Internal policy engine with signed decision records | — (0) | NO TEST |
| M03-01 | v1 | Arm addendum generation | — (0) | NO TEST |
| M04-02 | v1 | IRB package assembly | — (0) | NO TEST |
| M05-01 | v1 | AI-assisted pre-screening | — (0) | NO TEST |
| M08-02 | v1 | Agent-proposed deviations | — (0) | NO TEST |
| M09-02 | v1 | AI-assisted TMF filing | — (0) | NO TEST |
| FIN-03 | v1 | Shared-cost allocation keys | — (0) | NO TEST |
| FIN-07 | v1 | Sponsor runway linked to enrollment forecast | — (0) | NO TEST |
| APP-DT-01 | v2 | Versioned REST API in OpenAPI 3.1 | packages/api/test/platform.test.ts (1) | PASS |
| APP-AU-01 | v2 | Apps push audit events to the core | — (0) | NO TEST |
| FIN-09 | v2 | Cost per arm vs CRO quotes | — (0) | NO TEST |
| DEMO-01 | v2 | One-command demo reset | — (0) | NO TEST |
| EDC-01 | v1 | Versioned CRF library linked to protocol visits | — (0) | NO TEST |
| EDC-03 | v1 | Site data entry | — (0) | NO TEST |
| EDC-04 | v1 | Declarative edit checks | — (0) | NO TEST |
| EDC-05 | v1 | Query workflow | — (0) | NO TEST |
| EDC-11 | v1 | No arm data in blinded eCRF | — (0) | NO TEST |
| EDC-12 | v1 | visit.completed event and data-collection metric | — (0) | NO TEST |
| EDC-02 | v2 | eCRF versions per arm/stage | — (0) | NO TEST |
| EDC-06 | v2 | SDV and reviews | — (0) | NO TEST |
| EDC-07 | v2 | PI signature | — (0) | NO TEST |
| EDC-08 | v2 | Locks and data freeze | — (0) | NO TEST |
| DEMO-04 | v0 | Visible 'synthetic data - demonstration environment' label and page code on every page | apps/web/test/pages.test.ts (4) | PASS |
| AI-09 | v1 | Per-job limits (max_steps, max_tokens, max_cost, max_execution_time); an overrun stops the job and creates a task for a person | packages/api/test/ai.test.ts, packages/api/test/jobs.test.ts (7) | PASS |
| IAM-01 | gxp-p0 | MFA mandatory for every role with GxP impact (TOTP or passkey); signing with MFA step-up | apps/web/test/pages.test.ts, db/tests/access_controls.test.mjs, packages/api/test/access_controls.test.ts (10) | PASS |
| CMP-03 | gxp-p0 | Session idle timeout and account lockout after repeated failed logins or signing attempts, both recorded in the audit trail | apps/web/test/pages.test.ts, db/tests/access_controls.test.mjs, packages/api/test/access_controls.test.ts (14) | PASS |
| CMP-10 | gxp-p0 | Audit trail review for QA/inspector roles: filter by record, user and period; readable PDF/CSV export; reviews recorded and signed | apps/web/test/pages.test.ts, db/tests/audit_review.test.mjs, packages/api/test/audit_review.test.ts (14) | PASS |
| CMP-11 | gxp-p0 | Signature manifestation (printed name, UTC date/time, meaning, reason) on screen, print and export; reason stored on the signature record | apps/web/test/pages.test.ts, db/tests/audit_review.test.mjs, packages/api/test/audit_review.test.ts, packages/shell/test/manifest.test.ts (7) | PASS |
| CMP-15 | gxp-p0 | Every table in the core schema is audited (attach_std) or listed in a justified exception list; checked by a test | db/tests/compliance.test.mjs (2) | PASS |
| CMP-09 | gxp-p0 | AI-generated content carries a persistent marker (agent, ai_request, reviewer) wherever it is shown or exported; users are told when content is AI-generated | apps/web/test/pages.test.ts, db/tests/audit_review.test.mjs, packages/api/test/audit_review.test.ts, packages/shell/test/manifest.test.ts (5) | PASS |
| NFR-04 | gxp-p0 | Backups with point-in-time recovery, documented quarterly restore test, retention policy per platform (default 25 years) and archive readable for the whole period | db/tests/retention.test.mjs (3) | PASS |
| CMP-12 | v1 | Audit ledger sealed in blocks with Ed25519 and anchored outside the database; DDL on audited objects recorded; database admin roles segregated | — (0) | NO TEST |
| CMP-13 | v1 | Read access to unblinded data (sac_enclave) and every export recorded and reportable | — (0) | NO TEST |
| CMP-14 | v1 | Certified copies: export of a record or a whole trial (data, audit trail, signatures, hashes) in an open, human-readable format | — (0) | NO TEST |
| CMP-05 | v1 | ICH E6(R3) data governance: critical-to-quality factors, RBQM, reconstructability of every decision and adaptation, service provider oversight | — (0) | NO TEST |
| CMP-06 | v1 | Each GxP AI task type has a context of use, risk, credibility plan, test results and monitoring (docs/ai/<task_type>.md) | — (0) | NO TEST |
| CMP-07 | v1 | AI test data independent from development, pre-specified metrics, explainability through cited sources, model change control | — (0) | NO TEST |
| CMP-08 | v1 | Privacy by design across GDPR, HIPAA and APPI: pseudonymisation in the core, minimisation, record of processing, DPA/BAA with every provider, data residency per region | — (0) | NO TEST |
| AI-02 | v1 | Every GxP task type registered with intended use, risk, exact approved model and version, versioned prompt, validator, thresholds, test dataset | — (0) | NO TEST |
| AI-03 | v1 | GxP task types pinned to a dated model snapshot; a model change is a change request with regression on the test dataset | — (0) | NO TEST |
| AI-04 | v1 | Fixed generation parameters, JSON Schema output, mandatory source citation for extraction and classification | — (0) | NO TEST |
| AI-10 | v1 | Continuous monitoring per task type (accuracy on reviewed samples, drift, rejection rate); below threshold the task type falls back to suggestion-only | — (0) | NO TEST |
| APP-DT-02 | v1 | Writes require Idempotency-Key; optimistic concurrency with If-Match on the version | — (0) | NO TEST |
| APP-DT-05 | v1 | Provenance on every app-written datum: source_app, source_record_id, source_version, transformation_id | — (0) | NO TEST |
| NFR-05 | v1 | TLS 1.2+, encryption at rest, server-side secrets, SAST, dependency scanning and SBOM in CI; penetration test before production | — (0) | NO TEST |
| NFR-06 | v1 | Same code deployable in EU, US and Japan regions with data kept separate per region | — (0) | NO TEST |
| NFR-07 | v1 | WCAG 2.1 AA; UI localisable, with English and Japanese for site- and subject-facing pages | — (0) | NO TEST |
| VAL-01 | v1 | Every test carries the requirement IDs it covers; CI fails when a gated requirement has no passing test | — (0) | NO TEST |
| VAL-02 | v1 | No direct change in test or production: promotion only through the pipeline with approval; IQ check after every deploy | — (0) | NO TEST |
| VAL-03 | v1 | Database migrations tested on a synthetic or anonymised copy before promotion | — (0) | NO TEST |
| VAL-04 | v1 | L2–L3 apps not activated in production without the supplier validation package and passing contract tests | — (0) | NO TEST |
| VAL-05 | gxp-p0 | Requirements carry gxp_impact, risk, assurance and regulatory references; CI generates per-regulation compliance matrices from docs/compliance/crosswalk.json | db/tests/compliance.test.mjs (1) | PASS |
| IAM-06 | v2 | Periodic access review every 90 days generated as a signed task for the platform admin | — (0) | NO TEST |
| APP-ID-03 | v2 | SCIM 2.0 user provisioning to apps; deactivation propagated within 5 minutes | — (0) | NO TEST |
| UX-01 | v0 | Suggest changes: a button at the top right of every signed-in page numbers the components of the page (or of the open dialog) with stable codes <PAGE CODE>.Cnn from the page-code registry, data-fc codes winning, and opens a panel to describe the change (decided by Luca Emili, 2026-10-12) | apps/web/test/pages.test.ts, packages/shell/test/suggest.test.ts (6) | PASS |
| UX-02 | v0 | Change requests: stored in the name of the signed-in person with server UTC time and status new, readable by the persons of the platform; only platform admins change status and triage note (TRO-060), every change audited, removal is a void with a reason | apps/web/test/pages.test.ts, db/tests/change_requests.test.mjs, packages/api/test/change_requests.test.ts, packages/shell/test/suggest.test.ts (10) | PASS |
