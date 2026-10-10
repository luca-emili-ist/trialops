// IAM-01 (MFA mandatory, signing with MFA step-up) and CMP-03 (idle timeout, account lockout, both audited): the access
// policy of the Platform API (lib/access-policy.ts) and the sign-in routes (routes/auth.ts) over migration 0018.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApi, sign, DEMO_PASSWORD, TEST_TOTP, SIGN, type Api } from './_helpers.ts';

let api: Api;
let exempt: Api;
let off: Api;
before(async () => {
  api = await startApi();
  exempt = await startApi({}, { access: { mfaExemptDomains: ['demo.trialops.example'] } });
  off = await startApi({}, { access: { mfa: 'off' } });
});
after(async () => { await Promise.all([api?.close(), exempt?.close(), off?.close()]); });

const aal1 = (a: Api, sub: string) => a.tokenFor(sub, { aal: 'aal1', amr: [{ method: 'password' }], session_id: randomUUID() });
const events = async (a: Api, where: string, args: unknown[] = []) =>
  (await a.admin.query(`select event, email, sub, detail from core.auth_event where ${where} order by at, id`, args)).rows;
const taskId = async (a: Api) => (await a.admin.query('select id from core.task order by created_at limit 1')).rows[0].id as string;
const login = (a: Api, email: string, password: string) => a.call('POST', '/v1/auth/login', { body: { email, password } });

test('[IAM-01] a person with a role is refused at aal1 (403 mfa_required) and accepted at aal2; GET /v1/me shows the MFA status', async () => {
  const t1 = await aal1(api, 'demo|ctm');
  const refused = await api.call('GET', '/v1/platforms', { token: t1 });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'mfa_required');
  const me = await api.call('GET', '/v1/me', { token: t1 });
  assert.equal(me.status, 200, 'the sign-in can read its own status before the MFA step');
  assert.deepEqual(me.body.mfa, { required: true, satisfied: false, exempt: false, enrolled: false, aal: 'aal1' });
  assert.equal(me.body.session.idle_timeout_minutes, 15);
  const ok = await api.call('GET', '/v1/platforms', { as: 'demo|ctm' });
  assert.equal(ok.status, 200);
  const me2 = await api.call('GET', '/v1/me', { as: 'demo|ctm' });
  assert.deepEqual(me2.body.mfa, { required: true, satisfied: true, exempt: false, enrolled: true, aal: 'aal2' });
});

test('[IAM-01] a token without aal claim is treated as aal1; agents and people without roles are not asked for MFA', async () => {
  const noAal = await api.tokenFor('demo|ctm', { aal: undefined, amr: undefined });
  assert.equal((await api.call('GET', '/v1/platforms', { token: noAal })).body.error.code, 'mfa_required');
  const me = await api.call('GET', '/v1/me', { token: await api.tokenFor('demo|ctm', { aal: 'aal1', roles: [] }) });
  assert.equal(me.body.mfa.required, false);
  const plat = (await api.admin.query("select id from core.platform where code = 'PLAT-001'")).rows[0].id;
  const agent = await sign({ sub: 'agent:protocol-author', actor_type: 'agent', roles: ['platform_ops_manager'], platform_ids: [plat], arm_scopes: '*', site_scopes: '*' });
  assert.equal((await api.call('GET', '/v1/platforms', { token: agent })).status, 200);
});

test('[IAM-01] demo deviation: exempt email domains work at aal1 and /v1/me reports the exemption', async () => {
  const t1 = await aal1(exempt, 'demo|ctm');
  assert.equal((await exempt.call('GET', '/v1/platforms', { token: t1 })).status, 200);
  const me = await exempt.call('GET', '/v1/me', { token: t1 });
  assert.deepEqual(me.body.mfa, { required: true, satisfied: false, exempt: true, enrolled: false, aal: 'aal1' });
  // the same domain on the normal policy is not exempt
  assert.equal((await api.call('GET', '/v1/platforms', { token: await aal1(api, 'demo|ctm') })).status, 403);
});

test('[IAM-01] TRIALOPS_MFA=off: no MFA check', async () => {
  const t1 = await aal1(off, 'demo|ctm');
  assert.equal((await off.call('GET', '/v1/platforms', { token: t1 })).status, 200);
  assert.equal((await off.call('GET', '/v1/me', { token: t1 })).body.mfa.required, false);
});

test('[IAM-01][CMP-03] sign-in through the API: password (aal1, recorded), then the authenticator code completes it (aal2)', async () => {
  const r = await login(api, 'CTM@demo.trialops.example', DEMO_PASSWORD);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.id, 'demo|ctm');
  assert.ok(r.body.refresh_token);
  const token = r.body.access_token as string;
  assert.equal((await api.call('GET', '/v1/platforms', { token })).status, 403, 'aal1 after the password');
  const wrong = await api.call('POST', '/v1/auth/mfa/verify', { token, body: { factor_id: 'totp-demo|ctm', code: '000000' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'mfa_failed');
  const v = await api.call('POST', '/v1/auth/mfa/verify', { token, body: { factor_id: 'totp-demo|ctm', code: TEST_TOTP } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await api.call('GET', '/v1/platforms', { token: v.body.access_token })).status, 200);
  const ev = await events(api, "sub = 'demo|ctm'");
  assert.deepEqual(ev.map(e => [e.event, e.email, e.detail.step ?? e.detail.aal]),
    [['login_succeeded', 'ctm@demo.trialops.example', 'aal1'], ['login_failed', 'ctm@demo.trialops.example', 'totp']]);
  const bad = await login(api, 'ctm@demo.trialops.example', 'not-the-password');
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'invalid_credentials');
});

test('[IAM-01] enrolment of an authenticator: verifying the first code is recorded as mfa_enrolled', async () => {
  api.factors.set('demo|dm', [{ id: 'new-factor', factor_type: 'totp', status: 'unverified' }]);
  const r = await login(api, 'dm@demo.trialops.example', DEMO_PASSWORD);
  const v = await api.call('POST', '/v1/auth/mfa/verify', { token: r.body.access_token, body: { factor_id: 'new-factor', code: TEST_TOTP } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual((await events(api, "sub = 'demo|dm' and event = 'mfa_enrolled'")).map(e => e.detail.factor_id), ['new-factor']);
  api.factors.delete('demo|dm');
});

test('[IAM-01] signing with an authenticator requires its code and is recorded as reauth_mfa', async () => {
  const target = await taskId(api);
  const body = { target_table: 'task', target_id: target, meaning: 'review' };
  const noCode = await api.call('POST', '/v1/signatures', { as: 'demo|reg', reason: 'check', body: { ...body, password: DEMO_PASSWORD } });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.body.error.code, 'mfa_code_required');
  const badCode = await api.call('POST', '/v1/signatures', { as: 'demo|reg', reason: 'check', body: { ...body, password: DEMO_PASSWORD, totp: '999999' } });
  assert.equal(badCode.status, 401);
  assert.equal(badCode.body.error.code, 'reauth_failed');
  const ok = await api.call('POST', '/v1/signatures', { as: 'demo|reg', reason: 'reviewed', body: { ...body, ...SIGN } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.auth_method, 'reauth_mfa');
});

test('[IAM-01] signing is refused without an authenticator when MFA is mandatory; password only for an exempt demo account', async () => {
  const target = await taskId(api);
  const body = { target_table: 'task', target_id: target, meaning: 'review', password: DEMO_PASSWORD };
  api.factors.set('demo|reg', []);
  const r = await api.call('POST', '/v1/signatures', { as: 'demo|reg', reason: 'reviewed', body });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'mfa_required');
  api.factors.delete('demo|reg');
  exempt.factors.set('demo|reg', []);
  const e = await exempt.call('POST', '/v1/signatures', { as: 'demo|reg', reason: 'reviewed', body: { ...body, target_id: await taskId(exempt) } });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal(e.body.auth_method, 'reauth_password');
});

test('[CMP-03] 5 failed sign-ins lock the account (423); while locked no identity provider call and every token is refused', async () => {
  const email = 'cra@demo.trialops.example';
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await login(api, email, `wrong-${i}`)).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 423]);
  const calls = api.idpCalls();
  const locked = await login(api, email, DEMO_PASSWORD);
  assert.equal(locked.status, 423);
  assert.equal(locked.body.error.code, 'account_locked');
  assert.equal(api.idpCalls(), calls, 'the identity provider is not asked while the account is locked');
  const req = await api.call('GET', '/v1/platforms', { as: 'demo|cra' });
  assert.equal(req.status, 423, 'an existing token of the locked person is refused too');
  const ev = await events(api, 'email = $1', [email]);
  assert.deepEqual(ev.map(e => e.event), ['login_failed', 'login_failed', 'login_failed', 'login_failed', 'login_failed', 'account_locked', 'login_failed']);
  assert.equal(ev.at(-1)!.detail.reason, 'account_locked');
  assert.equal(ev.find(e => e.event === 'account_locked')!.sub, 'demo|cra', 'the subject is stored when the person is known');
  const lock = (await api.admin.query('select failures, locked_until - locked_at d from core.account_lock where email = $1', [email])).rows[0];
  assert.equal(lock.failures, 5);
  assert.equal(lock.d.minutes, 30);
});

test('[CMP-03] unlock: only a platform admin, with a reason, audited; then the person can sign in again', async () => {
  const email = 'cra@demo.trialops.example';
  const byCtm = await api.call('POST', '/v1/admin/accounts/unlock', { as: 'demo|ctm', reason: 'please', body: { email } });
  assert.equal(byCtm.status, 403);
  const noReason = await api.call('POST', '/v1/admin/accounts/unlock', { as: 'demo|admin', body: { email } });
  assert.equal(noReason.status, 400);
  const list = await api.call('GET', '/v1/admin/accounts/locks', { as: 'demo|admin' });
  assert.deepEqual(list.body.items.map((l: { email: string }) => l.email), [email]);
  const r = await api.call('POST', '/v1/admin/accounts/unlock', { as: 'demo|admin', reason: 'identity confirmed by phone', body: { email } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.unlocked, 1);
  const audit = (await api.admin.query(`select actor_sub, action, reason, new_row->>'unlocked_by' by from core.audit_event
    where table_name = 'account_lock' and action = 'UPDATE'`)).rows;
  assert.deepEqual(audit, [{ actor_sub: 'demo|admin', action: 'UPDATE', reason: 'identity confirmed by phone', by: 'demo|admin' }]);
  assert.deepEqual((await events(api, "event = 'account_unlocked'")).map(e => [e.email, e.detail.reason]), [[email, 'identity confirmed by phone']]);
  assert.equal((await api.call('POST', '/v1/admin/accounts/unlock', { as: 'demo|admin', reason: 'again', body: { email } })).status, 404);
  assert.equal((await login(api, email, DEMO_PASSWORD)).status, 200);
  assert.equal((await api.call('GET', '/v1/platforms', { as: 'demo|cra' })).status, 200);
});

test('[CMP-03] failed signature re-authentications count towards the lockout', async () => {
  const body = { target_table: 'task', target_id: await taskId(api), meaning: 'review', password: 'wrong', totp: TEST_TOTP };
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await api.call('POST', '/v1/signatures', { as: 'demo|ops', reason: 'try', body })).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 423]);
  assert.equal((await api.call('GET', '/v1/me', { as: 'demo|ops' })).status, 423);
  const ev = await events(api, "sub = 'demo|ops'");
  assert.deepEqual(ev.map(e => e.event), [...Array(5).fill('signature_reauth_failed'), 'account_locked']);
  assert.equal(ev[0]!.email, 'ops@demo.trialops.example');
});

test('[CMP-03] idle beyond the limit: 401 session_idle, the session stays ended and the timeout is in the audit trail', async () => {
  const sid = randomUUID();
  await api.admin.query(`insert into core.user_session(session_id, sub, email, started_at, last_seen_at)
    values ($1, 'demo|ctm', 'ctm@demo.trialops.example', now() - interval '40 minutes', now() - interval '16 minutes')`, [sid]);
  const token = await api.tokenFor('demo|ctm', { session_id: sid });
  const r = await api.call('GET', '/v1/platforms', { token });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'session_idle');
  assert.match(r.body.error.message, /after 15 minutes of inactivity/);
  assert.equal((await api.call('GET', '/v1/me', { token })).body.error.code, 'session_idle', 'an ended session stays ended');
  const s = (await api.admin.query('select ended_at is not null ended, end_reason from core.user_session where session_id = $1', [sid])).rows[0];
  assert.deepEqual(s, { ended: true, end_reason: 'idle_timeout' });
  const ev = await events(api, 'session_id = $1', [sid]);
  assert.deepEqual(ev.map(e => [e.event, e.detail.source]), [['session_idle_timeout', 'server']]);
  const audit = (await api.admin.query("select count(*)::int n from core.audit_event where table_name = 'user_session' and new_row->>'session_id' = $1 and action = 'UPDATE'", [sid])).rows[0].n;
  assert.equal(audit, 1, 'the end of the session is audited');
  // a session active 10 minutes ago is fine and its heartbeat moves
  const live = randomUUID();
  await api.admin.query(`insert into core.user_session(session_id, sub, last_seen_at) values ($1, 'demo|ctm', now() - interval '10 minutes')`, [live]);
  assert.equal((await api.call('GET', '/v1/platforms', { token: await api.tokenFor('demo|ctm', { session_id: live }) })).status, 200);
  const seen = (await api.admin.query('select now() - last_seen_at < interval \'1 minute\' fresh from core.user_session where session_id = $1', [live])).rows[0];
  assert.equal(seen.fresh, true);
});

test('[CMP-03] sign-out and the idle timer of the client end the session on the server', async () => {
  const sid = randomUUID();
  const token = await api.tokenFor('demo|fin', { session_id: sid });
  assert.equal((await api.call('GET', '/v1/me', { token })).status, 200);
  const end = await api.call('POST', '/v1/auth/session/end', { token, body: { reason: 'idle_timeout' } });
  assert.deepEqual(end.body, { ended: true });
  assert.equal((await api.call('GET', '/v1/me', { token })).body.error.code, 'session_idle');
  const sid2 = randomUUID();
  const t2 = await api.tokenFor('demo|fin', { session_id: sid2 });
  assert.equal((await api.call('POST', '/v1/auth/session/end', { token: t2, body: { reason: 'logout' } })).status, 200);
  assert.equal((await api.call('GET', '/v1/me', { token: t2 })).body.error.code, 'session_ended');
  assert.deepEqual((await events(api, "sub = 'demo|fin'")).map(e => [e.event, e.detail.source ?? null]), [['session_idle_timeout', 'client'], ['logout', null]]);
});

test('[CMP-03] auth events are append-only and mirrored in the hash-chained audit trail', async () => {
  const n = (await api.admin.query('select count(*)::int n from core.auth_event')).rows[0].n;
  const mirrored = (await api.admin.query("select count(*)::int n from core.audit_event where table_name = 'auth_event' and action = 'INSERT'")).rows[0].n;
  assert.ok(n > 0);
  assert.equal(mirrored, n);
  await assert.rejects(api.admin.query("update core.auth_event set event = 'login_succeeded'"), /append-only/);
  await assert.rejects(api.admin.query('delete from core.auth_event'), /append-only/);
  assert.equal((await api.admin.query('select core.audit_verify() broken')).rows[0].broken, null);
});
