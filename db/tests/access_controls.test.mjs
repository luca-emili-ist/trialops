// CMP-03 account lockout and session idle timeout, IAM-01 MFA enrolment record (migration 0018): the database side.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

const SYSTEM = { sub: 'system:auth', actor_type: 'system' };
const person = (sub, roles, extra = {}) => ({ sub, roles, platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', actor_type: 'user', email: `${sub.split('|')[1]}@demo.trialops.example`, ...extra });
async function refuse(run, re) {
  await c.query('savepoint refuse');
  try { await rejects(run(), re); } finally { await c.query('rollback to savepoint refuse'); }
}
const fail = (email, sub = null, event = 'login_failed') =>
  c.query("select core.auth_failure($1, $2, $3, null, '{}', 5, 15, 30) u", [event, email, sub]).then(r => r.rows[0].u);
const asService = { role: 'auth_service', claims: SYSTEM };

test('[CMP-03] app roles cannot read or write the sign-in tables nor call the bookkeeping functions', async () => {
  for (const role of ['anon', 'authenticated', 'app_service']) {
    await tx(c, async () => {
      for (const t of ['auth_event', 'account_lock', 'user_session']) await refuse(() => c.query(`select * from core.${t} limit 1`), /permission denied/);
      await refuse(() => c.query("delete from core.account_lock"), /permission denied/);
      await refuse(() => fail('cra@demo.trialops.example'), /permission denied/);
      await refuse(() => c.query("select core.access_check('demo|cra', null, null, 15)"), /permission denied/);
    }, { role, claims: person('demo|cra', ['cra']) });
  }
});

test('[CMP-03] five failures within the window open a lock, with server time and the subject of the person', async () => {
  await tx(c, async () => {
    const email = 'CRA@demo.trialops.example';
    for (let i = 0; i < 4; i++) assert.equal(await fail(email), null);
    const until = await fail(email);
    assert.ok(until instanceof Date);
    await c.query('reset role');
    const l = (await c.query('select email, sub, failures, locked_until - locked_at d from core.account_lock')).rows;
    assert.deepEqual(l.map(x => [x.email, x.sub, x.failures, x.d.minutes]), [['cra@demo.trialops.example', 'demo|cra', 5, 30]]);
    assert.ok((await c.query("select core.auth_login_check('cra@demo.trialops.example') u")).rows[0].u, 'login refused while locked');
    assert.equal((await c.query("select core.access_check('demo|cra', 'cra@demo.trialops.example', null, 15) v")).rows[0].v, 'account_locked');
    assert.equal((await c.query("select core.access_check('demo|cra', null, null, 15) v")).rows[0].v, 'account_locked', 'by subject too');
    const ev = (await c.query("select event, actor_sub, at <= clock_timestamp() ok from core.auth_event order by at")).rows;
    await c.query('set local role auth_service');
    assert.deepEqual(ev.map(e => e.event), [...Array(5).fill('login_failed'), 'account_locked', 'login_failed']);
    assert.ok(ev.every(e => e.actor_sub === 'system:auth' && e.ok));
    // the thresholds passed by the caller are clamped: a lock never opens after fewer than 3 failures
    assert.equal((await c.query("select core.auth_failure('login_failed', 'ctm@demo.trialops.example', null, null, '{}', 1, 15, 30) u")).rows[0].u, null);
  }, asService);
});

test('[CMP-03] failed signature re-authentications count with failed sign-ins of the same person', async () => {
  await tx(c, async () => {
    for (let i = 0; i < 3; i++) await fail('qa@demo.trialops.example', 'demo|qa', 'signature_reauth_failed');
    assert.equal(await fail('qa@demo.trialops.example'), null);
    assert.ok(await fail(null, 'demo|qa', 'signature_reauth_failed'));
  }, asService);
});

test('[CMP-03] unlock: platform admin only, with a reason, never their own account; audited with the reason', async () => {
  await tx(c, async () => {
    await c.query("set local role auth_service");
    for (let i = 0; i < 5; i++) await fail('cra@demo.trialops.example');
    for (let i = 0; i < 5; i++) await fail('admin@demo.trialops.example');
    await c.query('reset role');
    const unlock = (claims, reason, email) => tx2(claims, reason, () => c.query('select core.account_unlock($1) n', [email]));
    async function tx2(claims, reason, fn) {
      await c.query('savepoint u');
      try {
        await c.query("select set_config('request.jwt.claims', $1, true), set_config('trialops.change_reason', $2, true)", [JSON.stringify(claims), reason ?? '']);
        await c.query('set local role authenticated');
        const r = await fn();
        await c.query('reset role');
        await c.query('release savepoint u');
        return r;
      } catch (e) { await c.query('rollback to savepoint u'); throw e; }
    }
    await rejects(unlock(person('demo|ctm', ['ctm']), 'please', 'cra@demo.trialops.example'), /platform administrator/);
    await rejects(unlock({ ...person('demo|admin', ['platform_admin']), actor_type: 'agent' }, 'x', 'cra@demo.trialops.example'), /platform administrator/);
    await rejects(unlock(person('demo|admin', ['platform_admin']), null, 'cra@demo.trialops.example'), /reason is required/);
    await rejects(unlock(person('demo|admin', ['platform_admin']), 'me', 'admin@demo.trialops.example'), /their own account/);
    const r = await unlock(person('demo|admin', ['platform_admin']), 'identity confirmed', 'cra@demo.trialops.example');
    assert.equal(r.rows[0].n, 1);
    const a = (await c.query("select actor_sub, reason from core.audit_event where table_name = 'account_lock' and action = 'UPDATE'")).rows;
    assert.deepEqual(a, [{ actor_sub: 'demo|admin', reason: 'identity confirmed' }]);
    const l = (await c.query("select unlocked_by, unlock_reason from core.account_lock where email = 'cra@demo.trialops.example'")).rows[0];
    assert.deepEqual(l, { unlocked_by: 'demo|admin', unlock_reason: 'identity confirmed' });
    await refuse(() => c.query("update core.account_lock set unlock_reason = 'changed' where email = 'cra@demo.trialops.example'"), /closed/);
    await refuse(() => c.query("update core.account_lock set locked_until = now() where email = 'admin@demo.trialops.example'"), /only be closed by an unlock/);
    await refuse(() => c.query('delete from core.account_lock'), /physical delete not allowed/);
    // after the unlock the old failures do not count again
    await c.query("set local role auth_service");
    assert.equal(await fail('cra@demo.trialops.example'), null);
  });
});

test('[CMP-03] idle timeout: a session idle beyond the limit is ended for good; the heartbeat is written at most once a minute', async () => {
  await tx(c, async () => {
    const idle = randomUUID(); const live = randomUUID(); const fresh = randomUUID();
    await c.query(`insert into core.user_session(session_id, sub, last_seen_at) values
      ($1, 'demo|ctm', now() - interval '16 minutes'), ($2, 'demo|ctm', now() - interval '5 minutes'), ($3, 'demo|ctm', now() - interval '20 seconds')`, [idle, live, fresh]);
    await c.query('set local role auth_service');
    const check = sid => c.query("select core.access_check('demo|ctm', 'ctm@demo.trialops.example', $1, 15) v", [sid]).then(r => r.rows[0].v);
    assert.equal(await check(idle), 'session_idle');
    assert.equal(await check(idle), 'session_idle', 'stays ended');
    assert.equal(await check(live), 'ok');
    assert.equal(await check(fresh), 'ok');
    assert.equal(await check(randomUUID()), 'ok', 'a new session is registered');
    await c.query('reset role');
    const rows = Object.fromEntries((await c.query('select session_id, ended_at is not null ended, end_reason, clock_timestamp() - last_seen_at < interval \'5 seconds\' touched from core.user_session')).rows.map(r => [r.session_id, r]));
    assert.deepEqual([rows[idle].ended, rows[idle].end_reason, rows[live].touched, rows[fresh].touched], [true, 'idle_timeout', true, false],
      'live (5 min) touched, fresh (20 s) left as is');
    const ev = (await c.query("select event, detail->>'source' src from core.auth_event where session_id = $1", [idle])).rows;
    assert.deepEqual(ev, [{ event: 'session_idle_timeout', src: 'server' }]);
    await refuse(() => c.query('update core.user_session set ended_at = null, end_reason = null where session_id = $1', [idle]), /cannot be reopened/);
    await refuse(() => c.query("update core.user_session set last_seen_at = now() - interval '1 hour' where session_id = $1", [live]), /back in time/);
    await refuse(() => c.query("update core.user_session set sub = 'demo|admin' where session_id = $1", [live]), /cannot be edited/);
    await refuse(() => c.query('delete from core.user_session'), /physical delete not allowed/);
    const audited = (await c.query("select count(*)::int n from core.audit_event where table_name = 'user_session' and action = 'UPDATE'")).rows[0].n;
    assert.equal(audited, 1, 'only the end is audited, not the heartbeat');
  });
});

test('[IAM-01][CMP-03] MFA enrolment, sign-in and sign-out are recorded; auth events are append-only', async () => {
  await tx(c, async () => {
    const sid = randomUUID();
    await c.query("select core.auth_login_succeeded('CTM@demo.trialops.example', 'demo|ctm', $1, '203.0.113.7', 'aal1')", [sid]);
    await c.query("select core.auth_mfa_enrolled('ctm@demo.trialops.example', 'demo|ctm', $1, 'factor-1')", [sid]);
    assert.equal((await c.query("select core.auth_session_end('demo|ctm', null, $1, 'logout') e", [sid])).rows[0].e, true);
    assert.equal((await c.query("select core.auth_session_end('demo|ctm', null, $1, 'logout') e", [sid])).rows[0].e, false);
    await c.query('reset role');
    const ev = (await c.query('select event, email, ip from core.auth_event where session_id = $1 order by at', [sid])).rows;
    assert.deepEqual(ev.map(e => e.event), ['login_succeeded', 'mfa_enrolled', 'logout']);
    assert.equal(ev[0].email, 'ctm@demo.trialops.example');
    await refuse(() => c.query("update core.auth_event set ip = null"), /append-only/);
    await refuse(() => c.query('delete from core.auth_event'), /append-only/);
    await refuse(() => c.query("insert into core.auth_event(event, email) values ('nonsense', 'x@y')"), /check/);
    const t = (await c.query("insert into core.auth_event(event, email, at) values ('logout', 'x@y', '2000-01-01') returning at")).rows[0].at;
    assert.ok(t.getFullYear() > 2000, 'the server clock, never a supplied time (rule 11)');
  }, asService);
});
