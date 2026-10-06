# Traceability matrix

Generated 2026-10-06T21:19:54.737Z by scripts/trace.mjs from test tags and test-results.xml.

| Requirement | Release | Description | Tests | Result |
| --- | --- | --- | --- | --- |
| CMP-01 | foundations | Append-only, hash-chained audit trail; tampering detectable | db/tests/audit.test.mjs (3) | PASS |
| CMP-02 | foundations | Part 11 e-signatures: immutable, linked to signed version | db/tests/audit.test.mjs, db/tests/protocol_arms.test.mjs, packages/api/test/protocol_arms.test.ts (4) | PASS |
| CMP-04 | foundations | ALCOA+: who/when/old/new/reason captured on every GxP change | db/tests/audit.test.mjs (1) | PASS |
| DM-01 | foundations | Every clinical entity carries platform_id (+ arm_id, site_id) | db/tests/protocol_arms.test.mjs (1) | PASS |
| DM-02 | foundations | Approved controlled versions are immutable; approval needs signature | db/tests/protocol_arms.test.mjs, packages/api/test/protocol_arms.test.ts (4) | PASS |
| DM-03 | foundations | Change reason mandatory on GxP updates; no physical delete | db/tests/audit.test.mjs, db/tests/sites_registry.test.mjs (4) | PASS |
| DM-05 | foundations | Deterministic synthetic demo seed; no real data | db/tests/tasks_apps_metrics.test.mjs (1) | PASS |
| IAM-02 | foundations | RLS driven by JWT claims platform_ids / arm_scopes / site_scopes | db/tests/access.test.mjs, db/tests/claims.test.mjs, db/tests/sites_registry.test.mjs, packages/api/test/platform.test.ts, packages/api/test/sites.test.ts (9) | PASS |
| IAM-03 | foundations | Sponsors see and write only their own arm | db/tests/access.test.mjs, packages/api/test/metrics.test.ts, packages/api/test/platform.test.ts, packages/api/test/protocol_arms.test.ts (5) | PASS |
| IAM-04 | foundations | Unblinded data only in sac_enclave for the unblinded role | db/tests/access.test.mjs, db/tests/claims.test.mjs (3) | PASS |
| IAM-05 | foundations | Separation of duties: the author of a GxP document or change cannot approve it | packages/api/test/protocol_arms.test.ts (1) | PASS |
| IAM-07 | foundations | Agents are never unblinded | db/tests/access.test.mjs, packages/api/test/platform.test.ts (2) | PASS |
| AI-05 | foundations | GxP AI output is a proposal until a person signs | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/protocol_arms.test.ts (3) | PASS |
| AI-06 | foundations | AI ledger with model version and input hash | db/tests/tasks_apps_metrics.test.mjs (1) | PASS |
| AI-11 | foundations | AI never sees unblinded data outside the SAC enclave | db/tests/access.test.mjs (1) | PASS |
| APP-MF-01 | foundations | App manifest validated against published JSON Schema | db/tests/schemas.test.mjs (3) | PASS |
| APP-MF-02 | foundations | App activation requires approval; scopes granted on approval | db/tests/tasks_apps_metrics.test.mjs (1) | PASS |
| APP-MF-04 | foundations | Uninstall revokes scopes | db/tests/tasks_apps_metrics.test.mjs (1) | PASS |
| APP-TK-02 | foundations | Task state machine with logged transitions | db/tests/tasks_apps_metrics.test.mjs (1) | PASS |
| APP-TK-04 | foundations | GxP tasks by agents/apps pass waiting_review + signature | db/tests/tasks_apps_metrics.test.mjs (3) | PASS |
| APP-DT-04 | foundations | Domain events in CloudEvents 1.0 via outbox | db/tests/protocol_arms.test.mjs, db/tests/schemas.test.mjs (2) | PASS |
| M01-04 | foundations | Arm lifecycle with allowed transitions and events | db/tests/protocol_arms.test.mjs, packages/api/test/protocol_arms.test.ts (5) | PASS |
| M05-02 | foundations | Enrollment funnel per site (blinded) | db/tests/tasks_apps_metrics.test.mjs (1) | PASS |
| M07-01 | foundations | SAE expedited reporting clock | db/tests/protocol_arms.test.mjs (1) | PASS |
| M11-01 | foundations | SURPASS TA3 metric catalogue with targets | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/metrics.test.ts (2) | PASS |
| M11-02 | foundations | Arm onboarding metrics computed from records | db/tests/tasks_apps_metrics.test.mjs, packages/api/test/metrics.test.ts (4) | PASS |
| APP-ID-01 | v0 | OIDC SSO via identity broker | — (0) | NO TEST |
| APP-ID-02 | v0 | Access token carries sub, email, org_id and TrialOps claims platform_ids, arm_scopes, roles, blinding | db/tests/claims.test.mjs, db/tests/sites_registry.test.mjs, packages/api/test/platform.test.ts (8) | PASS |
| APP-ID-02 | foundations | TrialOps claims (platform/arm/site scopes, blinding) added to the Supabase token | db/tests/claims.test.mjs, db/tests/sites_registry.test.mjs, packages/api/test/platform.test.ts (8) | PASS |
| AI-01 | v0 | All AI calls through POST /api/ai/tasks | services/ai-runtime/test/boundary.test.ts (3) | PASS |
| M01-01 | v0 | Structured Master Protocol / appendix editor | packages/api/test/protocol_arms.test.ts (2) | PASS |
| M01-02 | v0 | New-arm wizard with AI-drafted appendix and task plan | — (0) | NO TEST |
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
