// CMP-10 audit trail review, CMP-11 signature reason, CMP-09 AI provenance marker (migrations 0017, 0019).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

const person = (sub, roles, extra = {}) => ({ sub, roles, platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', actor_type: 'user', email: `${sub}@x`, ...extra });
const qa = () => person('demo|qa', ['qa_auditor']);
const admin = () => person('demo|admin', ['platform_admin']);
const search = (args = '') => c.query(`select * from core.audit_search(${args})`);
// Expects the statement to fail and keeps the surrounding test transaction usable (savepoint).
async function refuse(run, re) {
  await c.query('savepoint refuse');
  try { await rejects(run(), re); } finally { await c.query('rollback to savepoint refuse'); }
}

test('[CMP-10] app roles have no grant on core.audit_event: the audit trail is read only through audit_search', async () => {
  await tx(c, async () => { await refuse(() => c.query('select * from core.audit_event limit 1'), /permission denied/); }, { role: 'authenticated', claims: qa() });
  await tx(c, async () => { await refuse(() => c.query('select * from core.audit_event limit 1'), /permission denied/); }, { role: 'app_service', claims: qa() });
});

test('[CMP-10] audit_search answers qa_auditor and platform_admin and refuses sponsor, CRA, agents and anonymous callers', async () => {
  for (const claims of [qa(), admin()]) {
    await tx(c, async () => {
      const r = await search('p_limit => 5');
      assert.equal(r.rowCount, 5);
      assert.ok(Number(r.rows[0].seq) > Number(r.rows[4].seq), 'newest first');
    }, { role: 'authenticated', claims });
  }
  const refused = [
    person('demo|arden', ['arm_sponsor_lead'], { arm_scopes: [I.arms['ARM-A']] }),
    person('demo|cra', ['cra']),
    { ...qa(), sub: 'agent:protocol-author', actor_type: 'agent' },
    { sub: 'nobody' },
  ];
  for (const claims of refused) {
    await tx(c, async () => { await refuse(() => search(), /requires a person with role qa_auditor or platform_admin/); }, { role: 'authenticated', claims });
  }
  // even the database owner gets nothing without reviewer claims
  await tx(c, async () => { await refuse(() => search(), /qa_auditor or platform_admin/); });
});

test('[CMP-10] filters by table, record, actor and period; keyset pagination with p_before', async () => {
  await tx(c, async () => {
    const site = (await search(`p_table => 'site', p_record => '${I.sites[0]}', p_limit => null`)).rows;
    assert.ok(site.length >= 1 && site.every(r => r.table_name === 'site' && r.record_id === I.sites[0]));
    const page1 = (await search("p_limit => 3")).rows;
    const page2 = (await search(`p_limit => 3, p_before => ${page1[2].seq}`)).rows;
    assert.ok(Number(page2[0].seq) < Number(page1[2].seq));
    assert.equal((await search("p_from => now() + interval '1 day'")).rowCount, 0);
    assert.equal((await search("p_actor => 'no-such-actor-xyz'")).rowCount, 0);
  }, { role: 'authenticated', claims: qa() });
});

test('[CMP-10] rows of sac_enclave tables are never returned, not even to a platform admin (IAM-04, IAM-07)', async () => {
  await tx(c, async () => {
    await c.query('create table sac_enclave.cmp10_allocation (id uuid primary key default gen_random_uuid(), platform_id uuid, arm_id uuid)');
    await c.query("create trigger audit after insert on sac_enclave.cmp10_allocation for each row execute function core.audit_row('gxp')");
    await c.query('insert into sac_enclave.cmp10_allocation(platform_id, arm_id) values ($1, $2)', [I.platform, I.arms['ARM-A']]);
    const written = (await c.query("select count(*)::int n from core.audit_event where table_name = 'cmp10_allocation'")).rows[0].n;
    assert.equal(written, 1, 'the enclave row is in the ledger');
    for (const claims of [qa(), admin(), { ...admin(), blinding: 'unblinded' }]) {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      assert.equal((await search("p_table => 'cmp10_allocation', p_limit => null")).rowCount, 0);
      assert.ok((await search('p_limit => 50')).rows.every(r => r.table_name !== 'cmp10_allocation'));
    }
  });
});

test('[CMP-10] the subject allocation (arm_id) is redacted from audit values (blinding, rule 5)', async () => {
  const raw = (await c.query("select count(*)::int n from core.audit_event where table_name = 'subject' and new_row->>'arm_id' is not null")).rows[0].n;
  assert.ok(raw > 0, 'the ledger holds subject allocations, so the redaction is really exercised');
  await tx(c, async () => {
    const rows = (await search("p_table => 'subject', p_limit => 200")).rows;
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(!r.new_row || !('arm_id' in r.new_row), 'arm_id visible in new_row');
      assert.ok(!r.old_row || !('arm_id' in r.old_row), 'arm_id visible in old_row');
    }
  }, { role: 'authenticated', claims: qa() });
});

test('[CMP-10] a reviewer sees only the audit rows of the platforms in the token', async () => {
  await tx(c, async () => {
    const rows = (await search("p_table => 'site', p_limit => null")).rows;
    assert.equal(rows.length, 0);
  }, { role: 'authenticated', claims: { ...qa(), platform_ids: ['00000000-0000-4000-8000-0000000000ff'] } });
});

const insertSig = (target, meaning, signer = 'demo|qa') => c.query(`insert into core.signature(signer_sub, signer_name, meaning, target_table, target_id,
  target_hash, auth_method) values ($1, 'Olivia Grant', $2, $3, $4, 'h', 'reauth_password') returning id`, [signer, meaning, 'audit_review', target]);

test('[CMP-10] a review records filters, range and a server-computed row count, and completes only with a review signature of its author', async () => {
  await tx(c, async () => {
    const top = Number((await search('p_limit => 1')).rows[0].seq);
    const expected = (await search(`p_table => 'site', p_limit => null, p_min_seq => 1, p_max_seq => ${top}`)).rowCount;
    const r = (await c.query(`insert into core.audit_review(platform_id, filters, reviewed_from_seq, reviewed_to_seq, conclusion, row_count, created_by)
      values ($1, '{"table":"site"}', 1, $2, 'No anomalies', 999999, 'someone-else') returning *`, [I.platform, top])).rows[0];
    assert.equal(r.row_count, expected, 'row_count is computed by the database');
    assert.equal(r.created_by, 'demo|qa');
    assert.equal(r.status, 'open');
    await refuse(() => c.query(`insert into core.audit_review(platform_id, filters, reviewed_from_seq, reviewed_to_seq, conclusion)
      values ($1, '{"evil":"x"}', 1, 2, 'x')`, [I.platform]), /filters may only contain/);
    await refuse(() => c.query("update core.audit_review set status = 'completed' where id = $1", [r.id]), /check constraint|signature/);
    const approval = (await insertSig(r.id, 'approval')).rows[0].id;
    await refuse(() => c.query("update core.audit_review set status = 'completed', signature_id = $2 where id = $1", [r.id, approval]), /meaning review/);
    const other = (await insertSig(r.id, 'review', 'demo|admin')).rows[0].id;
    await refuse(() => c.query("update core.audit_review set status = 'completed', signature_id = $2 where id = $1", [r.id, other]), /only the reviewer/);
    await refuse(() => c.query("update core.audit_review set conclusion = 'changed' where id = $1", [r.id]), /cannot be edited/);
    const own = (await insertSig(r.id, 'review')).rows[0].id;
    await c.query("update core.audit_review set status = 'completed', signature_id = $2 where id = $1", [r.id, own]);
    await refuse(() => c.query("update core.audit_review set status = 'void' where id = $1", [r.id]), /completed audit review is immutable/);
    await refuse(() => c.query('delete from core.audit_review where id = $1', [r.id]), /physical delete not allowed|permission denied/);
  }, { role: 'authenticated', claims: qa(), reason: 'periodic audit trail review' });
});

test('[CMP-10] other roles cannot record or read audit reviews', async () => {
  await tx(c, async () => {
    await refuse(() => c.query(`insert into core.audit_review(platform_id, filters, reviewed_from_seq, reviewed_to_seq, conclusion)
      values ($1, '{}', 1, 2, 'x')`, [I.platform]), /row-level security|qa_auditor/);
    assert.equal((await c.query('select * from core.audit_review')).rowCount, 0);
  }, { role: 'authenticated', claims: person('demo|cra', ['cra']) });
});

test('[CMP-11] the signature stores the reason of the request and stays immutable; existing signatures remain valid', async () => {
  await tx(c, async () => {
    const s = (await c.query(`insert into core.signature(signer_sub, signer_name, meaning, target_table, target_id, target_hash, auth_method)
      values ('demo|reg', 'Elena Rossi', 'approval', 'task', gen_random_uuid(), 'h', 'reauth_password') returning id, reason`)).rows[0];
    assert.equal(s.reason, 'Content reviewed and approved');
    const a = (await c.query("select new_row->>'reason' r from core.audit_event where table_name = 'signature' and record_id = $1", [s.id])).rows[0];
    assert.equal(a.r, 'Content reviewed and approved', 'the audit row carries the stored reason');
    await refuse(() => c.query("update core.signature set reason = 'other' where id = $1", [s.id]), /append-only/);
    await refuse(() => c.query('delete from core.signature where id = $1', [s.id]), /append-only/);
  }, { reason: 'Content reviewed and approved', claims: { sub: 'demo|reg' } });
  const seeded = (await c.query('select count(*)::int n from core.signature where reason is null')).rows[0].n;
  assert.ok(seeded > 0, 'signatures created before 0017 stay valid with reason null');
  assert.equal((await c.query('select core.audit_verify() b')).rows[0].b, null, 'hash chain still verifies');
});

test('[CMP-09] AI provenance on an appendix version is validated, set once and immutable', async () => {
  await tx(c, async () => {
    const arm = I.arms['ARM-A'];
    const mp = (await c.query("select id from core.master_protocol_version where platform_id = $1 and status = 'approved'", [I.platform])).rows[0].id;
    const v = (await c.query(`insert into core.arm_appendix_version(platform_id, arm_id, master_protocol_version_id, version_label)
      values ($1, $2, $3, 'cmp09') returning id`, [I.platform, arm, mp])).rows[0].id;
    const ai = (await c.query(`insert into core.ai_request(platform_id, arm_id, task_type, data_class, provider, model, model_version, input_sha256)
      values ($1, $2, 'protocol.appendix.draft', 'CONFIDENTIAL_SPONSOR', 'replay', 'claude-opus-5-5', 'claude-opus-5-5', 'x') returning id`, [I.platform, arm])).rows[0].id;
    const other = (await c.query(`insert into core.ai_request(platform_id, arm_id, task_type, data_class, provider, model, model_version, input_sha256)
      values ($1, $2, 'protocol.appendix.draft', 'CONFIDENTIAL_SPONSOR', 'replay', 'm', 'm', 'x') returning id`, [I.platform, I.arms['ARM-B']])).rows[0].id;
    const p = { ai_request_id: ai, agent: 'protocol-author', model: 'claude-opus-5-5', model_version: 'claude-opus-5-5', reviewed_by: 'Marcus Ortega', decision: 'accepted' };
    const set = prov => c.query('update core.arm_appendix_version set ai_provenance = $2 where id = $1', [v, JSON.stringify(prov)]);
    await refuse(() => set({ ...p, reviewed_by: '' }), /needs agent, model, reviewed_by/);
    await refuse(() => set({ ...p, decision: 'rejected' }), /decision accepted\|edited/);
    await refuse(() => set({ ...p, ai_request_id: other }), /AI ledger request of this arm/);
    await set(p);
    const audit = (await c.query("select new_row->'ai_provenance'->>'agent' a from core.audit_event where table_name = 'arm_appendix_version' and record_id = $1 order by seq desc limit 1", [v])).rows[0];
    assert.equal(audit.a, 'protocol-author', 'recording the provenance is audited');
    await refuse(() => set({ ...p, reviewed_by: 'Someone else' }), /immutable once recorded/);
    await refuse(() => c.query('update core.arm_appendix_version set ai_provenance = null where id = $1', [v]), /immutable once recorded/);
    // an approved version cannot receive a provenance afterwards
    const approved = (await c.query("select id from core.arm_appendix_version where arm_id = $1 and status = 'approved'", [arm])).rows[0].id;
    await refuse(() => c.query('update core.arm_appendix_version set ai_provenance = $2 where id = $1', [approved, JSON.stringify(p)]), /only be recorded on a draft/);
  }, { reason: 'CMP-09 test', claims: { sub: 'demo|ops' } });
});
