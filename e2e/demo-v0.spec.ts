// Demo v0 scenario (Proposers' Day, 4 Nov 2026), driven through the web app like the live demo:
// sign in as a synthetic demo user -> platform dashboard -> new-arm wizard with the Protocol author and Onboarding planner
// agents (AI in replay mode, run as asynchronous jobs) -> review and signature -> app catalogue: install, approve scopes,
// assign an app role -> single sign-on into the TA1 test app -> native EDC: the site PI enters a value that fails an edit
// check, the query opens, the site answers it. Synthetic data only.
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { E2E } from './ports.ts';

// Synthetic demo person of the seed (db/seed/seed-demo.mjs) with the platform_admin role.
const ADMIN = { sub: 'demo|admin', name: 'Dana Whitfield' };
// Synthetic principal investigator of site 101 (site_pi role), who enters EDC data.
const SITE_PI = { sub: 'demo|pi101', name: 'Dr. PI Site 101' };
// Test value accepted only by the local re-authentication of scripts/dev.mjs (never a real account password).
const SIGN_PASSWORD = process.env.TRIALOPS_E2E_SIGN_PASSWORD ?? 'demo-password';
// Fixed code of the local test authenticator of scripts/dev.mjs (IAM-01: the demo user switch stands for an MFA sign-in).
const SIGN_TOTP = process.env.TRIALOPS_DEV_TOTP ?? '123456';
const TA1_HOST = 'https://ta1-test-app.trialops.example';   // base_url of the TA1 test app manifest (catalogue)
const ARM = 'ARM-P';
const shot = (page: Page, name: string) => page.screenshot({ path: join(import.meta.dirname, 'screens', `${name}.png`), fullPage: true });

const panel = (page: Page, title: string) => page.locator('section.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

let ta1: ChildProcess | null = null;
let platformId = '';

test.beforeAll(async ({ request }) => {
  // The TA1 test app needs the platform id to ask TrialOps for a sign-in on that platform.
  const login = await request.post(`${E2E.apiUrl}/v1/dev/login`, { data: { sub: ADMIN.sub } });
  expect(login.ok()).toBeTruthy();
  const { access_token } = await login.json();
  const platforms = await (await request.get(`${E2E.apiUrl}/v1/platforms`, { headers: { authorization: `Bearer ${access_token}` } })).json();
  platformId = platforms.items[0].id;
  ta1 = spawn(process.execPath, [join(import.meta.dirname, '..', 'examples/ta1-test-app/src/server.ts')], {
    env: { ...process.env, PORT: String(E2E.ta1Port), TRIALOPS_ISSUER: E2E.apiUrl, TA1_REDIRECT_URI: `${TA1_HOST}/callback`,
      TA1_PLATFORM_ID: platforms.items[0].id }, stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    ta1!.stdout!.on('data', d => { if (String(d).includes('TA1 test app on')) resolve(); });
    ta1!.once('exit', code => reject(new Error(`TA1 test app exited (${code})`)));
  });
});
test.afterAll(() => { ta1?.kill(); });

test('[DEMO-02][M01-01][M01-02][AI-05][AI-06][APP-MF-01][APP-ID-01][APP-ID-02][EDC-03][EDC-04][EDC-05] demo v0 end to end', async ({ page, context, request }) => {
  // The TA1 test app is published at its manifest URL; in this test that host is served by the local TA1 server.
  await context.route(`${TA1_HOST}/**`, async route => {
    const u = new URL(route.request().url());
    const response = await route.fetch({ url: `http://localhost:${E2E.ta1Port}${u.pathname}${u.search}`, maxRedirects: 0 });
    await route.fulfill({ response });
  });

  await test.step('sign in as a synthetic demo user', async () => {
    await page.goto('/#/login');
    await expect(page.getByRole('heading', { name: 'Sign in to TrialOps' })).toBeVisible();
    await expect(page.getByText('Synthetic data — demonstration environment')).toBeVisible();
    await page.getByRole('row', { name: new RegExp(ADMIN.name) }).getByRole('button', { name: 'Sign in' }).click();
  });

  await test.step('platform dashboard', async () => {
    await expect(page.getByRole('heading', { level: 1 })).toContainText('PLAT-001');
    await expect(page.getByText('SURPASS TA3 metrics against target')).toBeVisible();
    await expect(page.getByText('TRO-001')).toBeVisible();
    await shot(page, '01-dashboard');
  });

  await test.step('new-arm wizard: arm details and sponsor documents', async () => {
    await page.goto('/#/arms/new');
    await expect(page.getByRole('heading', { name: 'Start a new arm' })).toBeVisible();
    await page.getByLabel('Arm code').fill(ARM);
    const sponsor = page.getByLabel('Sponsor');
    await sponsor.selectOption((await sponsor.locator('option', { hasText: 'Meridian' }).first().getAttribute('value'))!);
    await page.getByRole('button', { name: 'Use the synthetic example' }).click();
    await shot(page, '02-wizard-details');
    await page.getByRole('button', { name: 'Create draft arm and assign the agents' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(`Onboarding ${ARM}`) })).toBeVisible();
  });

  await test.step('the agents prepare the appendix and the onboarding plan (asynchronous AI jobs)', async () => {
    const jobs: number[] = [];
    page.on('response', r => { if (r.url().endsWith('/run-agent')) jobs.push(r.status()); });
    await page.getByRole('button', { name: 'Run the agents' }).click();
    await expect(page.getByText('AI-generated appendix proposal — changes to the draft')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/AI-generated by protocol author .* not yet reviewed by a person/)).toBeVisible();   // CMP-09
    await expect(page.getByText(/Onboarding tasks created by the planner \(9\)/)).toBeVisible({ timeout: 60_000 });
    expect(jobs).toEqual([202, 202]);
    await expect(page.getByText('Sources cited')).toBeVisible();
    await shot(page, '03-wizard-proposal');
  });

  await test.step('a person accepts the proposal with an electronic signature', async () => {
    await page.getByRole('button', { name: 'Accept and sign' }).click();
    await page.getByLabel('Password').fill(SIGN_PASSWORD);
    await page.getByLabel('Authenticator code').fill(SIGN_TOTP);
    await page.getByRole('button', { name: 'Sign and accept' }).click();
    await expect(page.getByText(`${ARM} is ready for submission`)).toBeVisible();
    await expect(page.getByText(/AI-generated by protocol author .* reviewed by /)).toBeVisible();   // CMP-09 provenance on the accepted content
    await shot(page, '04-wizard-signed');
  });

  await test.step('the AI ledger records the agent calls', async () => {
    await page.goto('/#/ai');
    await expect(page.getByRole('cell', { name: 'protocol.appendix.draft' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'arm.onboarding.plan' }).first()).toBeVisible();
  });

  await test.step('app catalogue: install the TA1 test app, approve its scopes, assign an app role', async () => {
    await page.goto('/#/apps');
    const catalogue = panel(page, 'Catalogue');
    await catalogue.getByRole('row').filter({ hasText: 'ist.ta1-test-app' }).getByRole('button', { name: 'Request installation' }).click();
    const installed = panel(page, 'Installed on this platform').getByRole('row').filter({ hasText: 'ist.ta1-test-app' });
    await expect(installed).toContainText('pending approval');
    await installed.getByRole('button', { name: 'Review scopes' }).click();
    await expect(page.getByRole('dialog')).toContainText('platform:read');
    await page.getByRole('button', { name: 'Approve and activate' }).click();
    await expect(installed.getByRole('cell').nth(2)).toHaveText('active');
    await expect(installed).toContainText('arm:read platform:read');
    await installed.getByRole('button', { name: 'Assign role' }).click();
    const person = page.getByLabel('Person');
    await person.selectOption((await person.locator('option', { hasText: ADMIN.name }).first().getAttribute('value'))!);
    await page.getByLabel('App role').selectOption('ta1test.viewer');
    await page.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(page.getByText('Role assigned')).toBeVisible();
    await shot(page, '05-apps-installed');
  });

  await test.step('single sign-on into the TA1 test app with the TrialOps identity, no password', async () => {
    const open = page.getByRole('link', { name: 'Open (sign in with TrialOps)' });
    const href = (await open.getAttribute('href'))!;
    expect(href).toBe(`${TA1_HOST}/login`);
    // The demo opens a new tab; the local demo session lives in this tab (sessionStorage), so the test follows the link here.
    await page.goto(href);
    await expect(page.getByRole('heading', { name: 'TA1 test app' })).toBeVisible();
    await expect(page.getByText('Signed in through TrialOps as')).toBeVisible();
    const identity = JSON.parse((await page.locator('pre').textContent())!);
    expect(identity.sub).toBe(ADMIN.sub);
    expect(identity.roles).toEqual(['ta1test.viewer']);
    expect(identity.blinding).toBe('blinded');
    await shot(page, '06-ta1-signed-in');
  });

  await test.step('EDC: the site PI enters a value that fails an edit check, a query opens, the site answers it', async () => {
    await page.goto('/#/');
    await page.getByRole('button', { name: 'Switch user' }).click();
    await page.getByRole('row', { name: new RegExp(SITE_PI.name) }).getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('PLAT-001');
    // a subject of site 101 on treatment without visits yet (the seed uses the first three)
    const login = await request.post(`${E2E.apiUrl}/v1/dev/login`, { data: { sub: SITE_PI.sub } });
    const { access_token } = await login.json();
    const list = await (await request.get(`${E2E.apiUrl}/v1/platforms/${platformId}/edc/subjects`, { headers: { authorization: `Bearer ${access_token}` } })).json();
    const subject = list.items.find((x: { visits: number; status: string }) => x.visits === 0 && x.status === 'on_treatment');
    expect(subject).toBeTruthy();
    expect(JSON.stringify(list)).not.toContain('arm_id');   // EDC-11: blinded
    await page.goto(`/#/edc/subjects/${subject.id}`);
    await expect(page.getByRole('heading', { name: `Subject ${subject.subject_code}` })).toBeVisible();
    await expect(page.getByText('TRO-073')).toBeVisible();
    await page.getByRole('row').filter({ hasText: 'Week 12' }).getByRole('button', { name: 'Start visit' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start visit' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('W12 Week 12');
    await expect(page.getByText('TRO-074')).toBeVisible();
    const vs = panel(page, 'Vital signs (F.VS)');
    await vs.getByRole('button', { name: 'Start form' }).click();
    await vs.getByLabel(/^Systolic blood pressure \(mmHg\)/).fill('270');
    await vs.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved: 1 edit check query opened')).toBeVisible();
    const open = vs.locator('[data-query="open"]');
    await expect(open).toContainText('Systolic blood pressure outside 60-250 mmHg');
    await expect(open).toContainText('edit check EC.VS.SYSBP.RANGE');
    await shot(page, '07-edc-query-opened');
    await open.getByRole('button', { name: 'Answer' }).click();
    await page.getByRole('dialog').getByLabel('Answer').fill('Confirmed against the source document (synthetic)');
    await page.getByRole('button', { name: 'Send answer' }).click();
    const answered = vs.locator('[data-query="answered"]');
    await expect(answered).toContainText('Confirmed against the source document (synthetic)');
    await expect(answered).toContainText('demo|pi101');
    await shot(page, '08-edc-query-answered');
  });
});
