// UX-02 change requests from "Suggest changes" (migration 0020): author and status from the server, admin-only triage,
// audited, void instead of delete, platform perimeter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

const person = (sub, roles, extra = {}) => ({ sub, roles, platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', actor_type: 'user', email: `${sub.replace('|', '.')}@x.test`, ...extra });
const cra = () => person('demo|cra', ['cra']);
const admin = () => person('demo|admin', ['platform_admin']);
async function refuse(run, re) {
  await c.query('savepoint refuse');
  try { await rejects(run(), re); } finally { await c.query('rollback to savepoint refuse'); }
}
const as = async (claims, sql, args = []) => {
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await c.query('set local role authenticated');
  const r = await c.query(sql, args);   // on error the caller's savepoint rollback also undoes the role
  await c.query('reset role');
  return r;
};
const suggest = (claims, extra = '') => as(claims, `insert into core.change_request(platform_id, page_code, component_code, component_kind, kind, request${extra ? ', ' + extra.split('=')[0] : ''})
  values ($1, 'TRO-010', 'TRO-010.C04', 'table', 'change', 'Add a column with the due date'${extra ? ', ' + extra.split('=')[1] : ''}) returning *`, [I.platform]);

test('[UX-02] a person suggests a change in their own name; author, email, time and status are set by the server', async () => {
  await tx(c, async () => {
    const r = (await suggest(cra(), "created_by='demo|admin'")).rows[0];
    assert.equal(r.created_by, 'demo|cra', 'the author cannot be chosen by the client');
    assert.equal(r.created_email, 'demo.cra@x.test');
    assert.equal(r.status, 'new');
    assert.equal(r.triage_note, '');
    assert.ok(Math.abs(Date.now() - r.created_at.getTime()) < 60_000, 'server time');
    const forged = (await suggest(cra(), "status='done'")).rows[0];
    assert.equal(forged.status, 'new', 'a request always starts new');
  });
});

test('[UX-02] agents cannot suggest; codes are validated; another platform is out of reach', async () => {
  await tx(c, async () => {
    await refuse(() => suggest({ ...cra(), sub: 'agent:protocol-author', actor_type: 'agent' }), /suggested by a person/);
    await refuse(() => as(cra(), `insert into core.change_request(platform_id, page_code, kind, request) values ($1, 'not a code', 'change', 'x')`, [I.platform]), /check constraint/);
    await refuse(() => as(cra(), `insert into core.change_request(platform_id, page_code, kind, request) values ($1, 'TRO-010', 'change', '   ')`, [I.platform]), /check constraint/);
    await refuse(() => suggest(person('demo|cra', ['cra'], { platform_ids: ['00000000-0000-4000-8000-000000000000'] })), /row-level security/);
  });
});

test('[UX-02] only a platform admin triages, only status and note change, every change is audited', async () => {
  await tx(c, async () => {
    const r = (await suggest(cra())).rows[0];
    const none = await as(cra(), "update core.change_request set status = 'done', triage_note = 'x' where id = $1", [r.id]);
    assert.equal(none.rowCount, 0, 'RLS: the triage policy hides the row from a non-admin');
    const u = (await as(admin(), "update core.change_request set status = 'triaged', triage_note = 'Next sprint' where id = $1 returning *", [r.id])).rows[0];
    assert.deepEqual([u.status, u.triage_note, u.updated_by, u.row_version], ['triaged', 'Next sprint', 'demo|admin', 2]);
    await refuse(() => as(admin(), "update core.change_request set request = 'rewritten' where id = $1", [r.id]), /only the status and the triage note/);
    const audit = (await c.query("select action, actor_sub, old_row->>'status' o, new_row->>'status' n from core.audit_event where table_name = 'change_request' and record_id = $1 order by seq", [r.id])).rows;
    assert.deepEqual(audit.map(a => [a.action, a.actor_sub, a.o, a.n]), [['INSERT', 'demo|cra', null, 'new'], ['UPDATE', 'demo|admin', 'new', 'triaged']]);
  });
});

test('[UX-02] no physical delete: removal is a void with a reason, and a void request is closed', async () => {
  await tx(c, async () => {
    const r = (await suggest(cra())).rows[0];
    await refuse(() => c.query('delete from core.change_request where id = $1', [r.id]), /physical delete not allowed/);
    await refuse(() => as(admin(), "update core.change_request set status = 'void' where id = $1", [r.id]), /needs a reason/);
    await c.query("select set_config('trialops.change_reason', 'Duplicate of an earlier request', true)");
    await as(admin(), "update core.change_request set status = 'void' where id = $1", [r.id]);
    const e = (await c.query("select action, reason from core.audit_event where table_name = 'change_request' and record_id = $1 order by seq desc limit 1", [r.id])).rows[0];
    assert.deepEqual([e.action, e.reason], ['VOID', 'Duplicate of an earlier request']);
    await refuse(() => as(admin(), "update core.change_request set status = 'new' where id = $1", [r.id]), /void change request is closed/);
  });
});

test('[UX-02] every person of the platform reads the requests; app roles have no grant', async () => {
  await tx(c, async () => {
    const r = (await suggest(cra())).rows[0];
    const seen = await as(person('demo|arden', ['arm_sponsor_lead']), 'select id from core.change_request where id = $1', [r.id]);
    assert.equal(seen.rowCount, 1);
    const other = await as(person('demo|x', ['cra'], { platform_ids: ['00000000-0000-4000-8000-000000000000'] }), 'select id from core.change_request where id = $1', [r.id]);
    assert.equal(other.rowCount, 0, 'RLS: other platforms see nothing');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: 'app:x', actor_type: 'app' })]);
    await c.query('set local role app_service');
    await refuse(() => c.query('select * from core.change_request'), /permission denied/);
  });
});
