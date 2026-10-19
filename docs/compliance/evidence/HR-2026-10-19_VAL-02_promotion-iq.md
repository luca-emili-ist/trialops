# Human review note — VAL-02 promotion through the pipeline and IQ after every deploy (risk high)

| Field | Value |
| --- | --- |
| Requirement | VAL-02 (A11-4, A11-10, EMA-CS-VALID, JP-CSV-LIFECYCLE, P11-10a, E6R3-COMPSYS) |
| Change | `.github/workflows/promote.yml`, `scripts/release-check.mjs`, `scripts/iq-check.mjs`, `db/tests/release_pipeline.test.mjs` |
| Branch / author | `v1-quality-governance`, Claude Code (development engine), 2026-10-19 |
| Procedure and activation | `docs/compliance/RELEASE_PROMOTION.md` |
| Reviewer decision | **pending** — review and sign-off by a person other than the author before merge; activation (R3) by Luca |

## Design

- One workflow, started by hand with a tag and an environment. **verify**: tag `vX.Y.Z` on `main`, checked-out commit
  equals the tag, successful `ci` run on that commit, full gate again on a synthetic copy (OQ evidence).
  **deploy**: bound to the GitHub environment, so its required reviewers approve before any secret is available or any
  step runs; deploys the verified commit with netlify-cli pinned; then the IQ; the release record (environment, tag,
  commit, deploy id, approvers read from the run's approvals, IQ checks, result, UTC times) is uploaded and attached to
  the GitHub release.
- **IQ** checks: anonymous 401 (site and API), published deploy = this deploy and ready, deploy message/commit = released
  commit, deployed file SHA-1 = local build (no missing, changed or extra file), migrations applied = repository (both
  directions), audit chain intact, DDL audit active. PASS only if every required group ran and passed — a missing
  credential is a FAIL, never a silent pass.
- Inputs reach shell steps only through `env` (no expression injection); actions pinned to commit SHAs; minimal
  `permissions` per job; no secret in the repository.

## Threats considered

| Threat | Control | Test |
| --- | --- | --- |
| Deploy from a laptop or from another workflow | single workflow; no deploy script; other workflows checked | `[VAL-02] the promote workflow is the only deploy path…` |
| Promotion of unmerged or unreviewed code | tag must be an ancestor of `origin/main`; CI must have passed on the commit | `[VAL-02] a release can be promoted only from a vX.Y.Z tag on main…` |
| Building something other than what was tagged / verified | HEAD = tag (verify) and HEAD = verified commit (deploy) | same test |
| Self-approval | GitHub environment required reviewers + prevent self-review (activation step) | procedural, recorded approvers in the release record |
| Deployed content differs from the build (tampering, partial upload) | file-by-file SHA-1 comparison | `[VAL-02] IQ: the published deploy carries the released commit…` |
| Site or API left public | anonymous 401 checks | `[VAL-02] IQ: anonymous requests must get 401…` |
| Code and database out of step | migration level both ways | `[VAL-02] IQ: the database migration level equals the repository…` |
| IQ silently skipped | required groups, missing credential = FAIL | `[VAL-02] IQ result: PASS only when every required group ran…` |
| Shell injection through workflow inputs | inputs only through `env` | first test (line check) |

## Test evidence

`db/tests/release_pipeline.test.mjs` (6 tests: real git repositories, simulated Netlify API, local PostgreSQL); results in
`test-results.xml` of the CI run; traceability in `docs/traceability.md`.

## Not verifiable before activation

The live Netlify API responses (deploy `title`, files endpoint paging) and the GitHub approvals endpoint are exercised for
the first time at the first promotion to `test`; the release record of that run is the evidence. Branch/tag protection
and environment reviewers are GitHub settings (R3, Luca).
