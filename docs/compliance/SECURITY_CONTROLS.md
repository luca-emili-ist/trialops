# Security controls — NFR-05

Requirement NFR-05 (release v1): *TLS 1.2+, encryption at rest, server-side secrets, SAST, dependency scanning and SBOM in
CI; penetration test before production.* Regulatory clauses: 21 CFR 11.30, EMA computerised systems guideline (security),
GDPR art. 32, HIPAA §164.312.

Status on 2026-10-18. Automated checks: `db/tests/security_controls.test.mjs` (tests tagged `[NFR-05]`).

| Control | Status | How it is met | Evidence |
| --- | --- | --- | --- |
| TLS 1.2+ in transit (browser ↔ web app and API) | Met by the platform | Netlify serves the web app and the Platform API function only over HTTPS (TLS 1.2 and 1.3, automatic certificates, HTTP redirected to HTTPS). `netlify.toml` adds `Strict-Transport-Security` so browsers never fall back to HTTP. | `netlify.toml`; Netlify security documentation (vendor qualification, `ASSESSMENT_VENDORS.md`) |
| TLS 1.2+ in transit (API ↔ database) | Met | Supabase Postgres accepts TLS connections; the scripts that connect remotely verify the server certificate against the Supabase Root 2021 CA (`rejectUnauthorized: true`). | `scripts/pg-ssl.mjs`, `scripts/supabase-root-2021-ca.crt` |
| Encryption at rest | Met by the platform | Supabase encrypts the database, backups and storage at rest (AES-256, managed keys). No clinical data is stored outside Supabase; demo data is synthetic only (CLAUDE.md rule 7). | Supabase security documentation (vendor qualification) |
| Secrets only server-side | Met | Service keys, the JWT secret, the Anthropic API key and the audit-seal private key live in Netlify environment variables / the macOS Keychain, never in the repository or the frontend. The frontend receives only public values (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`). | Test `[NFR-05] the frontend gets only public configuration`; gitleaks on the full history (`security.yml`) |
| SAST | In CI, report-only | Semgrep CE with OWASP Top 10, TypeScript, React and secrets rules on every push and pull request and weekly. | `.github/workflows/security.yml` job `sast` |
| Dependency scanning | In CI, enforced | `npm audit --audit-level=high` fails the build on a high or critical advisory; OSV-Scanner on `package-lock.json` (report-only) on every push and weekly. | `.github/workflows/ci.yml` job `supply-chain`; `security.yml` job `deps` |
| SBOM | In CI | CycloneDX SBOM generated with `npm sbom --sbom-format cyclonedx` for every run and kept as the artifact `sbom-<commit>`. | `.github/workflows/ci.yml` job `supply-chain` |
| Penetration test before production | **Not done** | Procedural item. An independent penetration test of the web app, the Platform API (incl. OIDC and app tokens) and the Supabase configuration must be performed and its findings closed **before the first production use with real data**. Owner: QA / platform lead. | Open — to be recorded here with date, provider, scope and report reference |

## Open points for a human decision

1. **Enforcement of SAST and OSV findings.** `security.yml` is a shared template that runs in report-only mode
   (`ENFORCE: '0'`). To make findings fail the build in this repository only, list the jobs (`sast`, `deps`, `secrets`)
   one per line in `.github/ci-enforce`, after reviewing the current findings.
2. **Penetration test.** Choose the provider and schedule it before production; NFR-05 stays partially met until then.
3. **Vendor qualification** of Supabase and Netlify (TLS and at-rest encryption are their controls): see
   `ASSESSMENT_VENDORS.md`.
