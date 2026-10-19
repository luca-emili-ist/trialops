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
  assert.match(app, /banner=\{t\('Synthetic data — demonstration environment'\)\}/, 'translated (NFR-07), never removed');
  for (const f of ['Login.tsx', 'UiCatalogue.tsx']) assert.match(readFileSync(join(src, 'pages', f), 'utf8'), /Synthetic data — demonstration environment/);
});

const page = (f: string) => readFileSync(join(src, 'pages', f), 'utf8');

test('[DEMO-04] the page code in the footer is a button that copies the link to the current page', () => {
  const shell = readFileSync(join(src, '../../../packages/shell/src/AppShell.tsx'), 'utf8');
  assert.match(shell, /<PageCodeBadge code=\{pageCode\} \/>/, 'the footer uses the badge');
  assert.match(shell, /<button type="button" className="page-code t-mono" data-page-code=\{code\}/);
  assert.match(shell, /navigator\.clipboard\.writeText\(window\.location\.href\)/);
  assert.match(shell, /'Copy the link to this page'/);
  assert.match(shell, /'link copied'/);
  assert.match(shell, /window\.clearTimeout\(id\)/, 'the confirmation timer is cleaned up');
});

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

test('[IAM-01] the sign-in asks for the authenticator code or its enrolment before the app loads; signatures ask for the code', () => {
  assert.equal(PAGE_CODES.loginMfa, 'TRO-091');
  assert.equal(PAGE_CODES.loginMfaEnrol, 'TRO-092');
  assert.equal(PAGE_CODES.login.slice(0, 6), PAGE_CODES.loginMfa.slice(0, 6), 'same decade as the sign-in');
  const login = page('Login.tsx');
  assert.match(login, /step\?\.kind === 'challenge' \? PAGE_CODES\.loginMfa : step\?\.kind === 'enrol' \? PAGE_CODES\.loginMfaEnrol : PAGE_CODES\.login/);
  assert.match(login, /<PageFooter pageCode=\{code\} \/>/);
  assert.match(login, /<img src=\{qr\}/, 'QR code of the enrolment');
  assert.match(login, /Setup key/, 'secret as text when the QR code cannot be scanned');
  const session = readFileSync(join(src, 'session.tsx'), 'utf8');
  assert.match(session, /'\/v1\/auth\/login'/, 'password sign-in through the API (lockout)');
  assert.match(session, /'\/v1\/auth\/mfa\/verify'/);
  assert.match(session, /supabase\.auth\.setSession/);
  assert.match(session, /m\.mfa\?\.required && !m\.mfa\.satisfied && !m\.mfa\.exempt/, 'the app loads only after the MFA step');
  assert.match(session, /supabase\.auth\.mfa\.enroll\(\{ factorType: 'totp'/);
  assert.match(session, /<SignMfaContext\.Provider value=\{!!me\?\.mfa\?\.enrolled\}>/);
  const overlays = readFileSync(join(src, '../../../packages/shell/src/ui/overlays.tsx'), 'utf8');
  assert.match(overlays, /label=\{t\('Authenticator code'\)\}/);
  for (const f of ['ProtocolEditor.tsx', 'Tasks.tsx', 'AuditTrail.tsx', 'ArmWizard.tsx']) assert.match(page(f), /onSign=\{(async )?\(password, reason, totp\) =>/, f);
});

test('[CMP-03] idle timer with a warning 60 s before the limit; the API ending the session signs out with the reason', () => {
  const session = readFileSync(join(src, 'session.tsx'), 'utf8');
  assert.match(session, /const limit = minutes \* 60_000;/);
  assert.match(session, /setWarning\(idle >= limit - 60_000\)/);
  assert.match(session, /title=\{t\('Your session is about to end'\)\}/);
  assert.match(session, /Your session ended after \{minutes\} minutes of inactivity/);
  assert.match(session, /\/v1\/auth\/session\/end', \{ body: \{ reason: 'idle_timeout' \} \}/, 'the server records the timeout');
  assert.match(session, /setSessionEndHandler\(e => \{ void endLocally\(e\.message\); \}\)/);
  assert.match(readFileSync(join(src, 'api.ts'), 'utf8'), /const SESSION_END_CODES = \['session_idle', 'session_ended', 'account_locked'\];/);
  assert.match(page('Login.tsx'), /<Panel title=\{t\('Session ended'\)\}>/);
});

test('[UX-01] Suggest changes is at the top right of every signed-in page with the code of the page registry', () => {
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  assert.match(app, /\{s\.platform \? <SuggestChanges pageCode=\{code\} onSubmit=\{suggest\} loadOpen=\{openOn\}/);
  assert.match(app, /actions=\{<><LanguageSelect \/>/, 'the language switch is beside it (NFR-07)');
  assert.match(app, /const code = PAGE_CODES\[route\.page\]/, 'the page code comes from the registry, not from the DOM');
  assert.match(app, /if \(route\.page === 'login'\) return <Login \/>;/, 'the sign-in pages are rendered without the shell, so without the button');
  assert.match(app, /'\/v1\/change-requests'/);
});

test('[UX-02] the change requests page has its own code in a new Admin decade and is in the navigation only for platform admins', () => {
  assert.equal(PAGE_CODES.changeRequests, 'TRO-060');
  assert.deepEqual(parse('#/change-requests'), { page: 'changeRequests', params: {} });
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  assert.match(app, /label: 'Change requests', href: '#\/change-requests', pages: \['changeRequests'\], group: 'Admin', roles: CHANGE_ADMIN_ROLES/);
  const p = page('ChangeRequests.tsx');
  assert.match(p, /export const CHANGE_ADMIN_ROLES = \['platform_admin'\] as const/);
  assert.match(p, /changeRequestAsTask\(r\)/, 'Copy as task');
  assert.match(p, /<ReasonDialog/, 'removal asks for a reason');
  assert.match(p, /\/void`/, 'removal is a void, never a delete');
  assert.doesNotMatch(p, /'DELETE'/);
});

test('[AI-10][AI-08] AI monitoring has its own page in the Trust decade, for QA auditors and platform admins, exceptions first, mode changed with a reason', () => {
  assert.equal(PAGE_CODES.aiMonitoring, 'TRO-052');
  assert.deepEqual(parse('#/ai/monitoring'), { page: 'aiMonitoring', params: {} });
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  assert.match(app, /label: 'AI monitoring', href: '#\/ai\/monitoring', pages: \['aiMonitoring'\], group: 'Trust', roles: AI_MONITORING_ROLES/);
  const p = page('AiMonitoring.tsx');
  assert.match(p, /export const AI_MONITORING_ROLES = \['qa_auditor', 'platform_admin'\] as const/, 'same readers as GET /v1/ai/monitoring');
  assert.match(p, /<AttentionList items=\{attention\}/, 'exceptions first (P3)');
  assert.match(p, /'\/v1\/ai\/monitoring\/evaluate'/);
  assert.match(p, /'\/v1\/ai\/monitoring\/mode', \{ reason,/, 'the mode changes with a reason (DM-03)');
  assert.match(p, /\['Now', MODE_LABEL\[m\.mode\]\], \['After the change'/, 'the change is shown before it is made (P4)');
  assert.match(p, /const admin = s\.can\('platform_admin'\)/, 'only platform admins evaluate and change the mode');
});

test('[AI-07][AI-08] pending agent actions: what the agent wants to do in the AI material, decision records, confirm or reject with a reason', () => {
  assert.equal(PAGE_CODES.pendingActions, 'TRO-053');
  assert.deepEqual(parse('#/ai/pending'), { page: 'pendingActions', params: {} });
  const p = page('PendingActions.tsx');
  assert.match(p, /<Panel ai=\{p\.status === 'pending'\}/, 'unsigned agent content only while it waits (DESIGN rule 7)');
  assert.match(p, /<AiProvenance provenance=/);
  assert.match(p, /<DiffList sections=\{proposedChanges\(p\)\} \/>/, 'diff before the decision (P4)');
  assert.match(p, /\/v1\/ai\/pending-actions\/\$\{deciding\.p\.id\}\/decide`/);
  assert.match(p, /<ReasonDialog/);
  assert.match(p, /p\.confirm_roles\.some\(r => s\.me\?\.roles\.includes\(r\)\)/, 'only the confirm roles of the tool decide');
  const tasks = page('Tasks.tsx');
  assert.match(tasks, /\/v1\/tasks\/\$\{task\.id\}\/confirm-plan`/, 'plan confirmation on the task (AI-10 suggestion-only)');
  assert.match(tasks, /<Panel ai title=\{t\('AI-generated onboarding plan — waiting for confirmation'\)\}/);
  assert.match(readFileSync(join(src, 'App.tsx'), 'utf8'), /n\.href === '#\/ai\/pending' && mineHeld \? \{ count: mineHeld, severity: 'warn' as const \}/,
    'actions waiting for my roles are counted beside the navigation item (P11)');
});

test('[CMP-05][CMP-08][VAL-04] quality, provider, privacy and app validation read views have their own codes and the roles of the API', () => {
  assert.deepEqual([PAGE_CODES.quality, PAGE_CODES.providers, PAGE_CODES.privacy, PAGE_CODES.appValidation], ['TRO-054', 'TRO-055', 'TRO-056', 'TRO-057']);
  for (const [hash, pg] of [['#/quality', 'quality'], ['#/providers', 'providers'], ['#/privacy', 'privacy'], ['#/app-validation', 'appValidation']] as const) {
    assert.deepEqual(parse(hash), { page: pg, params: {} });
  }
  assert.match(page('Quality.tsx'), /export const QUALITY_ROLES = \['platform_admin', 'platform_ops_manager', 'qa_auditor'\] as const/);
  assert.match(page('Providers.tsx'), /export const PROVIDER_ROLES = \['platform_admin', 'qa_auditor'\] as const/);
  assert.match(page('Privacy.tsx'), /export const PRIVACY_ROLES = \['platform_admin', 'qa_auditor'\] as const/, 'same roles as GET /v1/privacy/check');
  assert.match(page('AppValidation.tsx'), /\/v1\/apps\/\$\{encodeURIComponent\(app\.app_id\)\}\/validation\?version=/);
  for (const f of ['Quality.tsx', 'Providers.tsx', 'Privacy.tsx', 'AiMonitoring.tsx', 'PendingActions.tsx']) assert.match(page(f), /<AttentionList /, `${f}: exceptions first (P3)`);
  for (const f of ['Quality.tsx', 'Providers.tsx', 'Privacy.tsx', 'AppValidation.tsx']) assert.doesNotMatch(page(f), /\bapi\(/, `${f} is a read view`);
});

test('[NFR-07] pages and tables are labelled for assistive technology: language of the page, skip link, named table regions', () => {
  const shell = readFileSync(join(src, '../../../packages/shell/src/AppShell.tsx'), 'utf8');
  assert.match(shell, /className="skip-link" href="#main"/);
  assert.match(shell, /<main className="shell-content" id="main" tabIndex=\{-1\}>/);
  assert.match(readFileSync(join(src, '../../../packages/shell/src/i18n.tsx'), 'utf8'), /document\.documentElement\.lang = locale/);
  assert.match(readFileSync(join(src, '../../../packages/shell/src/ui/DataTable.tsx'), 'utf8'), /tabIndex=\{0\} role="region" aria-label=\{label \?\? caption \?\? t\('Table'\)\}/);
});
