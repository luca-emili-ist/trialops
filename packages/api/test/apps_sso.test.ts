import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { discover, loginRequest, completeLogin, CLIENT_ID, type ProviderMetadata } from '@trialops/ta1-test-app';
import { startApi, platformId, type Api } from './_helpers.ts';
import { catalogue } from '../src/routes/apps.ts';

let api: Api; let plat: string; let meta: ProviderMetadata; let inst: any;
const REDIRECT = 'https://ta1-test-app.trialops.example/callback';
const manifest = () => structuredClone(catalogue().find(m => m.app_id === CLIENT_ID)!);
before(async () => { api = await startApi(); plat = await platformId(api.admin); meta = await discover(api.url); });
after(async () => api.close());

/** The web shell step: the signed-in user is sent to /oidc/authorize and the shell asks the API for a code. */
async function shellAuthorize(as: string, login: ReturnType<typeof loginRequest>, redirect = REDIRECT) {
  const p = new URL(login.url).searchParams;
  return api.call('POST', '/v1/oidc/authorize', { as, body: { client_id: p.get('client_id'), platform_id: p.get('platform_id'),
    redirect_uri: redirect, code_challenge: p.get('code_challenge'), code_challenge_method: 'S256', state: p.get('state'), nonce: p.get('nonce') } });
}
const codeOf = (redirectTo: string) => new URL(redirectTo).searchParams.get('code')!;

test('[APP-MF-01] the catalogue lists publisher, GxP class, scopes, residency and validation package', async () => {
  const r = await api.call('GET', '/v1/apps/catalogue', { as: 'demo|admin' });
  const sim = r.body.items.find((a: any) => a.app_id === 'ist.simulation-ta1');
  assert.deepEqual([sim.publisher, sim.gxp_class, sim.valid], ['InSilicoTrials Technologies', 'L2', true]);
  assert.ok(sim.validation_package);
  assert.ok(r.body.items.every((a: any) => a.valid));
});

test('[APP-MF-01] an invalid manifest blocks the installation', async () => {
  const bad = { ...manifest(), base_url: 'http://insecure.example' };
  const r = await api.call('POST', `/v1/platforms/${plat}/apps`, { as: 'demo|admin', body: { manifest: bad } });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /APP-MF-01/);
  assert.equal((await api.admin.query('select count(*)::int n from core.app_installation where app_id = $1', [CLIENT_ID])).rows[0].n, 0);
  assert.equal((await api.call('POST', `/v1/platforms/${plat}/apps`, { as: 'demo|ops', body: { manifest: manifest() } })).status, 403);
});

test('[APP-MF-02] installation waits for scope approval, approval grants the declared scopes', async () => {
  const r = await api.call('POST', `/v1/platforms/${plat}/apps`, { as: 'demo|admin', body: { manifest: manifest() } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending_approval');
  assert.deepEqual(r.body.scopes, []);
  inst = r.body;
  const login = loginRequest(meta, REDIRECT, plat);
  assert.equal((await shellAuthorize('demo|ctm', login)).status, 403, 'no sign-in before approval');
  const a = await api.call('POST', `/v1/app-installations/${inst.id}/approve`, { as: 'demo|admin' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.status, 'active');
  assert.deepEqual(a.body.scopes.map((s: any) => s.scope), ['arm:read', 'platform:read']);
});

test('[APP-ID-02] app roles are assigned in TrialOps and only if declared in the manifest', async () => {
  const ctm = (await api.admin.query("select id from core.person where idp_sub = 'demo|ctm'")).rows[0].id;
  const ok = await api.call('POST', `/v1/app-installations/${inst.id}/role-assignments`, { as: 'demo|admin', body: { person_id: ctm, role: 'ta1test.viewer' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const bad = await api.call('POST', `/v1/app-installations/${inst.id}/role-assignments`, { as: 'demo|admin', body: { person_id: ctm, role: 'ta1test.superuser' } });
  assert.equal(bad.status, 422);
});

test('[APP-ID-01][APP-ID-02] single sign-on: the app gets a verified identity with the TrialOps claims, no password', async () => {
  const login = loginRequest(meta, REDIRECT, plat);
  assert.ok(login.url.startsWith(meta.authorization_endpoint));
  const a = await shellAuthorize('demo|ctm', login);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(new URL(a.body.redirect_to).searchParams.get('state'), login.state);
  const { identity, access_token } = await completeLogin(meta, REDIRECT, codeOf(a.body.redirect_to), login);
  const ctm = (await api.admin.query("select org_id, email from core.person where idp_sub = 'demo|ctm'")).rows[0];
  assert.equal(identity.sub, 'demo|ctm');
  assert.equal(identity.email, ctm.email);
  assert.equal(identity.org_id, ctm.org_id);
  assert.deepEqual(identity.platform_ids, [plat]);
  assert.equal(identity.arm_scopes, '*');
  assert.deepEqual(identity.roles, ['ta1test.viewer']);
  assert.equal(identity.blinding, 'blinded');
  assert.equal(identity.aud, CLIENT_ID);
  const ui = await fetch(meta.userinfo_endpoint, { headers: { authorization: `Bearer ${access_token}` } });
  assert.equal(((await ui.json()) as any).sub, 'demo|ctm');
});

test('[APP-ID-01] codes are single use and bound to the PKCE verifier and redirect URI', async () => {
  const login = loginRequest(meta, REDIRECT, plat);
  const code = codeOf((await shellAuthorize('demo|ctm', login)).body.redirect_to);
  await assert.rejects(completeLogin(meta, REDIRECT, code, { ...login, verifier: 'x'.repeat(43) }), /invalid_grant/);
  await assert.rejects(completeLogin(meta, REDIRECT, code, login), /invalid_grant/, 'a code burnt by a failed attempt cannot be reused');
  const other = loginRequest(meta, REDIRECT, plat);
  assert.equal((await shellAuthorize('demo|ctm', other, 'https://evil.example/callback')).status, 422);
  const ok = loginRequest(meta, REDIRECT, plat);
  const c2 = codeOf((await shellAuthorize('demo|ctm', ok)).body.redirect_to);
  await completeLogin(meta, REDIRECT, c2, ok);
  await assert.rejects(completeLogin(meta, REDIRECT, c2, ok), /invalid_grant/);
});

test('[APP-ID-01][IAM-02] only people of the platform can sign in to its apps', async () => {
  assert.equal((await shellAuthorize('nobody', loginRequest(meta, REDIRECT, plat))).status, 403);
});

test('[APP-MF-04] uninstalling revokes scopes and stops sign-in at once', async () => {
  const login = loginRequest(meta, REDIRECT, plat);
  const code = codeOf((await shellAuthorize('demo|ctm', login)).body.redirect_to);
  const u = await api.call('POST', `/v1/app-installations/${inst.id}/uninstall`, { as: 'demo|admin' });
  assert.equal(u.body.status, 'uninstalled');
  assert.ok(u.body.scopes.every((s: any) => s.revoked_at));
  await assert.rejects(completeLogin(meta, REDIRECT, code, login), /invalid_grant/, 'a code issued before uninstall is no longer redeemable');
  assert.equal((await shellAuthorize('demo|ctm', loginRequest(meta, REDIRECT, plat))).status, 403);
});
