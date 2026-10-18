// NFR-05: security controls in CI (SAST, dependency scanning, SBOM) and secrets kept out of the frontend and the repo.
// Status of TLS, encryption at rest and penetration test: docs/compliance/SECURITY_CONTROLS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const read = p => readFileSync(join(root, p), 'utf8');

test('[NFR-05] CI runs SAST, dependency scanning, secret scanning and produces an SBOM', () => {
  const sec = read('.github/workflows/security.yml');
  const ci = read('.github/workflows/ci.yml');
  assert.match(sec, /semgrep scan[\s\S]*--config p\/owasp-top-ten/, 'SAST: Semgrep with OWASP rules');
  assert.match(sec, /osv-scanner --lockfile=package-lock\.json/, 'dependency scan: OSV-Scanner');
  assert.match(sec, /gitleaks git/, 'secret scan of the history');
  assert.match(sec, /pull_request/, 'security checks run on pull requests');
  assert.match(ci, /run: npm audit --audit-level=high\s*$/m, 'dependency scan that fails the build on high/critical');
  assert.match(ci, /npm sbom --sbom-format cyclonedx > sbom\.cdx\.json/, 'SBOM in CycloneDX format');
  assert.match(ci, /name: sbom-\$\{\{ github\.sha \}\}\s+path: sbom\.cdx\.json/, 'SBOM kept as a CI artifact');
  assert.match(ci, /migration-check\.mjs/, 'migration rule checked in CI (VAL-03)');
});

test('[NFR-05] HTTPS only: HSTS on the web app and certificate verification on remote database connections', () => {
  assert.match(read('netlify.toml'), /Strict-Transport-Security = "max-age=\d{7,}/);
  assert.match(read('scripts/pg-ssl.mjs'), /rejectUnauthorized: true/);
  const doc = read('docs/compliance/SECURITY_CONTROLS.md');
  for (const k of ['TLS 1.2', 'Encryption at rest', 'Secrets only server-side', 'SAST', 'SBOM', 'Penetration test']) assert.ok(doc.includes(k), k);
  assert.match(doc, /Penetration test before production \| \*\*Not done\*\*/, 'the pending penetration test is stated, not hidden');
});

// Values that are public by design in a browser: the project URL and the publishable (anon) key, protected by RLS.
const PUBLIC_VITE = /^VITE_[A-Z0-9_]*(_URL|_PUBLISHABLE_KEY|_ANON_KEY|_SITE_KEY|_ENV|_VERSION|_REGION)$/;
const SECRETISH = /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|TOKEN|API_KEY|ANTHROPIC/;
const SECRET_VALUES = [/sk-ant-[A-Za-z0-9_-]{10,}/, /sb_secret_[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"role"\s*:\s*"service_role"/, /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl/];

function walk(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    if (['node_modules', 'dist'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('[NFR-05] the frontend gets only public configuration and no secret is committed in frontend or env files', () => {
  const web = walk(join(root, 'apps/web'));
  const names = new Set();
  for (const f of web.filter(x => /\.(ts|tsx|js|mjs|html)$/.test(x))) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\bVITE_[A-Z0-9_]+/g)) names.add(m[0]);
    for (const re of SECRET_VALUES) assert.doesNotMatch(text, re, `${f} contains a secret-looking value`);
  }
  assert.ok(names.size > 0, 'the web app reads its public configuration from VITE_ variables');
  for (const n of names) {
    assert.doesNotMatch(n, SECRETISH, `${n}: VITE_ variables are shipped to the browser, never a secret`);
    assert.match(n, PUBLIC_VITE, `${n}: not a known public kind of value (URL, publishable key)`);
  }
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const envFiles = tracked.filter(f => /(^|\/)\.env(\.|$)/.test(f) && !/\.env\.example$/.test(f));
  assert.deepEqual(envFiles, [], 'no .env file in the repository');
  for (const f of tracked.filter(x => /\.env\.example$|netlify\.toml$|vite\.config\.[jt]s$/.test(x))) {
    const text = read(f);
    for (const re of SECRET_VALUES) assert.doesNotMatch(text, re, `${f} contains a secret-looking value`);
    for (const m of text.matchAll(/^\s*(VITE_[A-Z0-9_]+)\s*=/gm)) assert.doesNotMatch(m[1], SECRETISH, `${f}: ${m[1]}`);
  }
});
