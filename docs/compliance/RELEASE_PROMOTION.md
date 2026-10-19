# Release promotion and installation qualification

Requirement: **VAL-02** — no direct change in test or production: promotion only through the pipeline with approval;
IQ check after every deploy (Annex 11 §4/§10, EMA 2023 computerised systems validation, JP CSV life cycle,
21 CFR 11.10(a), ICH E6(R3) computerised systems). Human review of the design:
`docs/compliance/evidence/HR-2026-10-19_VAL-02_promotion-iq.md`.

## 1. Procedure

1. Code reaches `main` only through a reviewed pull request with a green `ci` run.
2. The release manager tags the commit on `main`: `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`.
3. Actions → **promote** → *Run workflow* with the tag and the environment (`test` first, then `production`).
4. Job **verify**: `scripts/release-check.mjs` (tag format, tag on `main`, checked-out commit = tag), a successful `ci` run
   on that commit, then the full gate on a synthetic copy (`db:reset` + `verify`, OQ evidence uploaded).
5. Job **deploy** waits for the **required reviewers of the GitHub environment** (production: QA, not the person who
   started the run). After approval it deploys the tagged commit (`netlify deploy --prod --build`, deploy message
   `trialops <tag> <commit>`), then runs the **IQ** (`scripts/iq-check.mjs`):
   anonymous 401 on site and API · the new deploy is the published one, ready, with the commit · deployed files equal
   the build (SHA-1) · migrations applied = migrations in the repository · `core.audit_verify()` clean · DDL audit active.
6. The **release record** (`iq-evidence/release-<env>-<tag>.json`: environment, tag, commit, deploy id, approvers,
   workflow run, every IQ check, PASS/FAIL, UTC times) is uploaded as an artifact and attached to the GitHub release.
7. IQ FAIL: the job fails; the release manager opens a deviation and either fixes forward with a new tag or re-promotes
   the previous tag (rollback = promotion of the previous release, through the same workflow).

Database migrations are applied to the target database before the promotion (`scripts/db-remote.mjs migrate`, by the
release manager, after the `migration-safety` checklist); the IQ fails if the database and the repository differ.
Manual `netlify deploy` to the test or production site is not allowed; a local preview uses a draft deploy or the local
stack.

## 2. Activation (one time, by Luca — R3, not done by the development engine)

1. GitHub → Settings → Environments: create `test` and `production`.
   - `production`: *Required reviewers* = the QA person(s); enable *Prevent self-review*; *Deployment branches and tags*
     = tags matching `v*`.
   - `test`: required reviewer = release manager or QA; same tag rule.
2. In each environment add the **secrets** `NETLIFY_AUTH_TOKEN` (a personal access token of the Netlify account,
   scoped to the TrialOps sites) and `IQ_DATABASE_URL` (a connection string of a read-only role that can read
   `public.schema_migrations` and execute `core.audit_verify()` and `core.ddl_audit_active()`; on Supabase the session
   pooler URL), and the **variables** `NETLIFY_SITE_ID` and `TRIALOPS_URL` of that environment's site.
3. Check that `NETLIFY_CLI_VERSION` in `.github/workflows/promote.yml` is a published netlify-cli version and update it
   if needed.
4. Branch protection on `main` (required `ci`, review by another person) and tag protection for `v*`. On a personal
   private repository GitHub does not enforce it (see GCP_BY_DESIGN §4.4): move the repository to an organisation plan
   that does.
5. Revoke CLI deploy rights from day-to-day accounts on the test/production sites (Netlify team roles) so that the
   workflow token is the only deployer, and stop using `netlify deploy --prod` from the CLI for those sites.
6. First run: promote the current release to `test`, check the release record, then to `production`.
