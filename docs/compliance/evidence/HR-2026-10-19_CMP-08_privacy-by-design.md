# Human review note — CMP-08 privacy by design (risk high)

| Field | Value |
| --- | --- |
| Requirement | CMP-08 (GDPR-25, GDPR-32, GDPR-44, HIPAA-312, APPI-SENSITIVE, APPI-TRANSFER) |
| Change | migration `0026_quality_privacy_governance.sql` (privacy part), `packages/api/src/routes/privacy.ts`, synthetic seed |
| Branch / author | `v1-quality-governance`, Claude Code (development engine), 2026-10-19 |
| Procedure | `docs/compliance/PRIVACY_BY_DESIGN.md` |
| Reviewer decision | **pending** — to be reviewed and signed off by a person other than the author before merge (CLAUDE.md rule 9) |

## Design

- **Pseudonymisation**: `core.subject.subject_code` constrained to pseudonym form (`NOT VALID`: new and changed rows;
  existing rows reported by the privacy check). Re-identification link only in `sac_enclave.reidentification_key`
  (opaque custodian reference + vault key id, no identity, no key material); no grant to any API role; write-only door
  `core.register_reidentification()` (site staff or app, inside the site perimeter); read only via
  `sac_enclave.reidentify()` (unblinded person, reason, logged in `core.data_access_log`). Enclave audit rows never reach
  `core.audit_search()` (0019).
- **Minimisation**: privacy check scans every core table holding participant data (`subject` and tables with `subject_id`)
  for identifier-like columns (pg_catalog, not filtered by privileges).
- **Agreements**: `core.provider_agreement` (DPA / BAA / APPI_TRANSFER / SCC / QUALITY_AGREEMENT) with dates, categories,
  regions, document hash; effective agreements immutable. The provider state machine refuses `active` while
  `core.provider_agreement_gaps()` is not empty, and re-checks when an active provider widens categories or regions.
- **Residency**: `core.platform.data_region` set once; `core.platform_provider` refuses participant data to a provider
  not processing in the platform region or without the region's agreement; apps must list the region in
  `data_residency`. `core.provider_allowed()` is the runtime check.
- **ROPA**: `core.ropa_entry` versioned, four-eyes approval, legal basis per region, recipients in the registry, approved
  versions immutable, previous approved version superseded.
- Every new table: `attach_std` (audit, no delete) or append-only, governance guard (person with platform_admin /
  qa_auditor), RLS on platform-scoped tables, no grant to `anon` or `app_service`.

## Threats considered

| Threat | Control | Test |
| --- | --- | --- |
| Direct identifiers stored in the core (names as subject codes, new PII columns) | pseudonym check constraint; minimisation scan | `[CMP-08] subject codes are pseudonyms…`, `…self-check detects an identifier column…` |
| Re-identification by blinded users, agents, apps or admins | no grants on the enclave table; unblinded-person-only function with logged reason | `[CMP-08][IAM-04] the re-identification link lives only in the enclave…` |
| Site registering links for subjects of other sites | perimeter check in the write function | same test (second part) |
| Provider activated without DPA/BAA/APPI, or with an expired one | provider state machine + gaps function | `[CMP-08] a provider with participant data is not activated without…` |
| Silent widening of what an active provider processes | re-check on category/region change | same test |
| Agreement edited after signature | immutability of effective agreements, SHA-256 required | same test |
| Transfer of participant data out of the platform region | platform_provider residency check; region set once; app residency | `[CMP-08] data residency…`, `[VAL-04][CMP-08] the app must keep its data…` |
| ROPA changed without review | versioning, four eyes, immutability | `[CMP-08] the record of processing activities is versioned data…` |
| Unauthorised maintenance (agents, other roles) | governance guard trigger + API role checks | API test `[CMP-05][CMP-08] provider lifecycle…` (403 cases) |

## Test evidence

DB tests `db/tests/privacy.test.mjs` (7), `db/tests/app_validation.test.mjs` (residency case), API tests
`packages/api/test/quality_privacy_governance.test.ts` (`[CMP-08]` cases); results in `test-results.xml` of the CI run of
this branch, traceability in `docs/traceability.md`.

## Known limits (follow-up)

- The AI runtime does not yet call `core.provider_allowed()` before routing a CLINICAL_PSEUDONYMIZED request (AI-07/AI-08
  work in parallel); until then the data-class policy of the runtime applies.
- Legal content of the agreements and of the ROPA (bases, transfer mechanisms) is a DPO/legal decision; the system
  enforces that it is recorded, current and complete per region.
