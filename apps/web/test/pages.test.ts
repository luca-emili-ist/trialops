// House rule §19: every page has a stable, unique code; and the design-system rule: pages use tokens, never raw colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_CODES } from '../src/pageCodes.ts';
import { ROUTE_PATTERNS, parse } from '../src/router.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');

test('[DEMO-04] page codes are unique, well formed and cover every route', () => {
  const codes = Object.values(PAGE_CODES);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.match(c, /^TRO-\d{3}$/);
  for (const r of ROUTE_PATTERNS) assert.ok(PAGE_CODES[r.page], `route ${r.re} has no page code`);
  assert.equal(parse('#/nope').page, 'notFound');
  assert.deepEqual(parse('#/protocol/appendix/00000000-0000-4000-8000-000000000000'), { page: 'protocolEditor', params: { kind: 'appendix', id: '00000000-0000-4000-8000-000000000000' } });
});

test('[DEMO-04] pages use design tokens only: no hex colours, rgb() or inline colour styles', () => {
  for (const dir of ['pages', 'components']) for (const f of readdirSync(join(src, dir))) {
    const code = readFileSync(join(src, dir, f), 'utf8');
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,6}\b(?![\w/-]*['"]?\])/, `${dir}/${f} contains a hex colour`);
    assert.doesNotMatch(code, /rgba?\(/, `${dir}/${f} contains rgb()`);
    assert.doesNotMatch(code, /style=\{\{[^}]*(color|background|font)/, `${dir}/${f} sets colours or fonts inline`);
  }
});

test('[DEMO-04] the synthetic-data label is on every page of the shell', () => {
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  assert.match(app, /banner="Synthetic data — demonstration environment"/);
  for (const f of ['Login.tsx', 'UiCatalogue.tsx']) assert.match(readFileSync(join(src, 'pages', f), 'utf8'), /Synthetic data — demonstration environment/);
});

const page = (f: string) => readFileSync(join(src, 'pages', f), 'utf8');

test('[CMP-10] the audit trail page has its own code in the Trust decade and is in the navigation only for QA and admins', () => {
  assert.equal(PAGE_CODES.auditTrail, 'TRO-051');
  assert.equal(PAGE_CODES.aiLedger.slice(0, 6), PAGE_CODES.auditTrail.slice(0, 6), 'same decade as the AI ledger (Trust)');
  assert.deepEqual(parse('#/audit'), { page: 'auditTrail', params: {} });
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  assert.match(app, /label: 'Audit trail', href: '#\/audit', pages: \['auditTrail'\], group: 'Trust', roles: AUDIT_ROLES/);
  assert.match(app, /NAV\.filter\(n => !n\.roles \|\| s\.can\(\.\.\.n\.roles\)\)/, 'role-restricted items are hidden');
  assert.match(app, /pageCode=\{code\}/, 'the shell footer shows the page code of every page, this one included');
  const p = page('AuditTrail.tsx');
  assert.match(p, /export const AUDIT_ROLES = \['qa_auditor', 'platform_admin'\] as const/);
  assert.match(p, /\/v1\/audit-events\/export\?/, 'CSV export');
  assert.match(p, /window\.print\(\)/, 'print view = PDF export');
  assert.match(p, /<SignDialog[^>]*meaning="review"/, 'a review is recorded with a signature of meaning review');
  assert.match(p, /<DataTable/);
  assert.match(readFileSync(join(src, '../../../packages/shell/src/shell.css'), 'utf8'), /@media print[\s\S]*\.shell-nav/);
});

test('[CMP-11] signatures are shown with their manifestation, not with a short id', () => {
  const editor = page('ProtocolEditor.tsx');
  assert.match(editor, /<SignatureManifest signature=\{ver\.approved_signature\}/);
  assert.doesNotMatch(editor, /short\(ver\.approved_signature_id\)/);
  assert.match(page('Tasks.tsx'), /<SignatureManifest signature=\{t\.review_signature\}/);
  assert.match(page('Arms.tsx'), /<SignatureManifest signature=\{v\.approved_signature\}/);
  assert.match(page('AuditTrail.tsx'), /<SignatureManifest signature=\{r\.signature\}/);
  assert.match(page('UiCatalogue.tsx'), /<SignatureManifest /, 'in the component catalogue (TRO-099)');
});

test('[CMP-09] AI proposals and accepted AI content are labelled AI-generated wherever they are shown', () => {
  for (const f of ['ProtocolEditor.tsx', 'ArmWizard.tsx', 'Tasks.tsx', 'Arms.tsx', 'UiCatalogue.tsx']) assert.match(page(f), /<AiProvenance /, f);
  assert.match(page('ArmWizard.tsx'), /title="AI-generated appendix proposal/);
  assert.match(page('Tasks.tsx'), /'AI-generated proposal'/);
});
