// AI-07 tool registry and AI-08 Agent Decision Records (migration 0025), enforced by the database: modes changed only by
// a platform admin with a reason, versioned and audited; a GxP write never AUTO; decision records written only through
// core.agent_decision_append (hash, sequence, chain, server time, actor, key checked), immutable; pending actions created
// by the agent with its REVIEW record and decided only by a person with a confirm role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, tx, ids, rejects } from './_helpers.mjs';
import { canonical, sha256 } from '../../packages/api/src/lib/canonical.ts';
import { decisionSigner } from '../../packages/api/src/lib/decision-signing.ts';
import { generateSealKey } from '../../packages/api/src/lib/audit-seal.ts';

let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

const OTHER = '00000000-0000-0000-0000-000000000000';
const person = (sub, roles, extra = {}) => ({ sub, roles, platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', actor_type: 'user', ...extra });
const admin = () => person('demo|admin', ['platform_admin']);
const agent = (id = 'onboarding-planner', extra = {}) => ({ sub: `agent:${id}`, actor_type: 'agent', roles: [], platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', ...extra });
async function refuse(run, re) {
  await c.query('savepoint refuse');
  try { await rejects(run(), re); } finally { await c.query('rollback to savepoint refuse'); }
}
const as = async (claims, sql, args = []) => {
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await c.query('set local role authenticated');
  const r = await c.query(sql, args);   // on error the savepoint of refuse() undoes the role and the claims
  await c.query('reset role');
  return r;
};
const setMode = (claims, tool, mode, reason, platform = I.platform) =>
  as(claims, 'select * from core.ai_tool_set_mode($1, $2, $3, $4)', [platform, tool, mode, reason]);

test('[AI-07] the default registry: three tools, a GxP write registered as BLOCK and never storable as AUTO', async () => {
  await tx(c, async () => {
    const r = (await c.query('select tool, effect, mode, version from core.ai_tool where platform_id is null order by tool')).rows;
    assert.deepEqual(r.map(x => [x.tool, x.effect, x.mode, x.version]), [['onboarding.tasks.create', 'operational_write', 'AUTO', 1],
      ['protocol.appendix.propose', 'proposal', 'AUTO', 1], ['protocol.appendix.write', 'gxp_write', 'BLOCK', 1]]);
    assert.equal((await c.query('select count(*)::int n from core.ai_tool_version where platform_id is null')).rows[0].n, 3);
    assert.equal((await c.query("select count(*)::int n from core.ai_tool_resolve($1, 'free.shell')", [I.platform])).rows[0].n, 0, 'unregistered: nothing resolves');
    await c.query("select set_config('trialops.change_reason', 'test', true)");
    await refuse(() => c.query("update core.ai_tool set mode = 'AUTO' where tool = 'protocol.appendix.write'"), /ai_tool_gxp_write_never_auto/);
    await refuse(() => c.query(`insert into core.ai_tool(platform_id, tool, description, effect, risk_level, mode, reason)
      values ($1, 'x.write', 'x', 'gxp_write', 'high', 'AUTO', 'x')`, [I.platform]), /ai_tool_gxp_write_never_auto/);
    await refuse(() => c.query(`insert into core.ai_tool(platform_id, tool, description, effect, risk_level, mode, reason)
      values ($1, 'x.confirm', 'x', 'read', 'low', 'CONFIRM', 'x')`, [I.platform]), /ai_tool_confirm_needs_roles/);
    await refuse(() => c.query("delete from core.ai_tool where tool = 'protocol.appendix.write'"), /physical delete not allowed/);
    await refuse(() => c.query("update core.ai_tool_version set mode = 'AUTO'"), /append-only/);
  });
});

test('[AI-07] a platform admin overrides a mode for one platform with a reason: versioned, audited, visible only there', async () => {
  await tx(c, async () => {
    const r = (await setMode(admin(), 'onboarding.tasks.create', 'CONFIRM', 'pilot: confirm every plan')).rows[0];
    assert.deepEqual([r.platform_id, r.mode, r.version, r.changed_by, r.effect, r.agents], [I.platform, 'CONFIRM', 1, 'demo|admin', 'operational_write', ['onboarding-planner']]);
    assert.ok(Math.abs(Date.now() - r.changed_at.getTime()) < 60_000, 'server time');
    const r2 = (await setMode(admin(), 'onboarding.tasks.create', 'BLOCK', 'planner suspended')).rows[0];
    assert.deepEqual([r2.id, r2.version, r2.mode], [r.id, 2, 'BLOCK']);
    assert.equal((await setMode(admin(), 'onboarding.tasks.create', 'BLOCK', 'again')).rows[0].version, 2, 'same mode: nothing recorded');
    const v = (await c.query('select version, mode, reason, changed_by from core.ai_tool_version where ai_tool_id = $1 order by version', [r.id])).rows;
    assert.deepEqual(v.map(x => [x.version, x.mode, x.reason, x.changed_by]), [[1, 'CONFIRM', 'pilot: confirm every plan', 'demo|admin'], [2, 'BLOCK', 'planner suspended', 'demo|admin']]);
    const audit = (await c.query("select action, reason from core.audit_event where table_name = 'ai_tool' and record_id = $1 order by seq", [r.id])).rows;
    assert.deepEqual(audit.map(a => [a.action, a.reason]), [['INSERT', 'pilot: confirm every plan'], ['UPDATE', 'planner suspended']]);
    const resolved = (await as(agent(), "select mode, version, version_id from core.ai_tool_resolve($1, 'onboarding.tasks.create')", [I.platform])).rows[0];
    assert.equal(resolved.mode, 'BLOCK');
    assert.equal(resolved.version_id, (await c.query('select id from core.ai_tool_version where ai_tool_id = $1 and version = 2', [r.id])).rows[0].id);
    const seen = (await as(person('demo|x', ['qa_auditor'], { platform_ids: [OTHER] }), "select platform_id from core.ai_tool where tool = 'onboarding.tasks.create'")).rows;
    assert.deepEqual(seen, [{ platform_id: null }], 'another platform sees only the default');
  });
});

test('[AI-07] only a person with platform_admin changes a mode, never directly, never AUTO for a GxP write, never on the default', async () => {
  await tx(c, async () => {
    await refuse(() => setMode(person('demo|ops', ['platform_ops_manager']), 'onboarding.tasks.create', 'CONFIRM', 'x'), /only a platform admin/);
    await refuse(() => setMode({ ...agent(), roles: ['platform_admin'] }, 'onboarding.tasks.create', 'AUTO', 'x'), /only a platform admin/);
    await refuse(() => setMode(admin(), 'onboarding.tasks.create', 'CONFIRM', ' '), /needs a reason/);
    await refuse(() => setMode(admin(), 'onboarding.tasks.create', 'MAYBE', 'x'), /AUTO, CONFIRM or BLOCK/);
    await refuse(() => setMode(admin(), 'protocol.appendix.write', 'AUTO', 'x'), /GxP write tool can never be AUTO/);
    await refuse(() => setMode(admin(), 'free.shell', 'AUTO', 'x'), /not registered/);
    await refuse(() => setMode(admin(), 'onboarding.tasks.create', 'BLOCK', 'x', null), /default registry changes only through a migration/);
    await refuse(() => setMode({ ...admin(), platform_ids: [OTHER] }, 'onboarding.tasks.create', 'BLOCK', 'x'), /outside the token/);
    await refuse(() => as(admin(), "update core.ai_tool set mode = 'AUTO' where tool = 'protocol.appendix.write'"), /permission denied/);
    await refuse(() => as(admin(), `insert into core.ai_tool(platform_id, tool, description, effect, risk_level, mode, reason)
      values ($1, 'x', 'x', 'read', 'low', 'AUTO', 'x')`, [I.platform]), /permission denied/);
    // CONFIRM for the GxP write is allowed: it still never runs without a person
    assert.equal((await setMode(admin(), 'protocol.appendix.write', 'CONFIRM', 'x')).rows[0].mode, 'CONFIRM');
  });
});

// ----- decision records -----
const signer = decisionSigner(generateSealKey().privateKeyPem);
async function head(claims) { return (await as(claims, 'select * from core.agent_decision_head()')).rows[0]; }
async function payload(claims, over = {}) {
  const h = await head(claims);
  return { v: 1, id: randomUUID(), seq: Number(h.next_seq), prev_record_sha256: h.prev_record_sha256, decided_at: h.decided_at,
    agent_id: 'onboarding-planner', tool: 'onboarding.tasks.create', tool_version_id: null, tool_mode: 'AUTO', platform_id: I.platform,
    arm_id: null, task_id: null, pending_action_id: null, decision: 'ALLOW', rule_ids: ['AI07-MODE-AUTO'], rationale: 'trialops-policy/1: test',
    inputs_sha256: sha256(canonical({ a: 1 })), ai_request_id: null, model: null, prompt_id: null, prompt_version: null,
    actor_sub: claims.sub, actor_type: claims.actor_type, key_id: signer.keyId, ...over };
}
function append(claims, p, opts = {}) {
  const text = opts.text ?? canonical(p);
  const signature = opts.unsigned ? null : (opts.signature ?? signer.sign(text));
  return as(claims, 'select core.agent_decision_append($1, $2, $3, $4, $5) id',
    [text, opts.hash ?? sha256(text), signature, opts.pem === undefined ? signer.publicKeyPem : opts.pem, JSON.stringify({ args: { a: 1 } })]);
}

test('[AI-08] a decision record is appended only through the policy-engine function: hash, chain, server time, actor and key checked', async () => {
  await tx(c, async () => {
    const a = agent();
    await refuse(async () => append(a, await payload(a), { hash: '0'.repeat(64) }), /record hash does not match/);
    await refuse(async () => append(a, await payload(a, { seq: 99 })), /out of chain/);
    await refuse(async () => append(a, await payload(a, { prev_record_sha256: '1'.repeat(64) })), /out of chain/);
    await refuse(async () => append(a, await payload(a, { decided_at: '2020-01-01T00:00:00.000000Z' })), /server time/);
    await refuse(async () => append(a, await payload(a, { actor_sub: 'demo|admin' })), /actor must be the caller/);
    await refuse(async () => append(a, await payload(a, { platform_id: OTHER })), /platform outside the token/);
    await refuse(async () => append(a, await payload(a, { decision: 'MAYBE' })), /are required/);
    await refuse(async () => append(a, await payload(a, { rule_ids: [] })), /are required/);
    await refuse(async () => append(a, await payload(a), { pem: null }), /unknown decision signing key/);
    await refuse(async () => append(a, await payload(a), { pem: generateSealKey().publicKeyPem }), /unknown decision signing key/);
    await refuse(async () => append(a, await payload(a, { key_id: null })), /needs the key id/);
    await refuse(async () => append({ ...a, actor_type: 'app' }, await payload(a)), /written by the policy engine/);
    const p1 = await payload(a);
    const id1 = (await append(a, p1)).rows[0].id;
    const r1 = (await c.query('select seq, signature_status, key_id, decision, policies_applied, decided_at, signed_payload from core.agent_decision_record where id = $1', [id1])).rows[0];
    assert.deepEqual([r1.signature_status, r1.key_id, r1.decision, r1.policies_applied, r1.signed_payload], ['signed', signer.keyId, 'ALLOW', ['AI07-MODE-AUTO'], canonical(p1)]);
    assert.ok(Math.abs(Date.now() - r1.decided_at.getTime()) < 60_000, 'server UTC time');
    const k = (await c.query('select ephemeral, registered_by from core.ai_decision_key where key_id = $1', [signer.keyId])).rows[0];
    assert.deepEqual(k, { ephemeral: false, registered_by: 'agent:onboarding-planner' });
    // next record links to the first; an unsigned one is accepted only as explicitly unsigned
    const p2 = await payload(a, { key_id: null });
    assert.equal(p2.prev_record_sha256, sha256(canonical(p1)));
    await refuse(async () => append(a, p2, { signature: 'x' }), /needs the key id/);
    const id2 = (await append(a, p2, { unsigned: true })).rows[0].id;
    assert.equal((await c.query('select signature_status from core.agent_decision_record where id = $1', [id2])).rows[0].signature_status, 'unsigned');
    // immutable, not writable directly, readable only in the platform perimeter
    await refuse(() => c.query("update core.agent_decision_record set decision = 'BLOCK' where id = $1", [id1]), /append-only/);
    await refuse(() => c.query('delete from core.agent_decision_record where id = $1', [id1]), /append-only/);
    await refuse(() => as(a, `insert into core.agent_decision_record(agent_id, tool, platform_id, request, decision, policies_applied, rationale, record_sha256)
      values ('x', 'x', $1, '{}', 'ALLOW', '{x}', 'x', repeat('0', 64))`, [I.platform]), /permission denied/);
    assert.equal((await as(person('demo|x', ['qa_auditor'], { platform_ids: [OTHER] }), 'select count(*)::int n from core.agent_decision_record')).rows[0].n, 0);
    assert.equal((await as(person('demo|qa', ['qa_auditor']), 'select count(*)::int n from core.agent_decision_record where id = any($1)', [[id1, id2]])).rows[0].n, 2);
    await refuse(() => as(person('demo|ops', ['platform_ops_manager']), 'select * from core.agent_decision_chain()'), /requires a person with role qa_auditor or platform_admin/);
    const chain = (await as(person('demo|qa', ['qa_auditor']), 'select seq, record_sha256 from core.agent_decision_chain()')).rows;
    assert.deepEqual(chain.slice(-2).map(x => x.record_sha256), [sha256(canonical(p1)), sha256(canonical(p2))]);
    const audit = (await c.query("select count(*)::int n from core.audit_event where table_name = 'agent_decision_record' and record_id = any($1)", [[id1, id2]])).rows[0];
    assert.equal(audit.n, 2);
  });
});

test('[AI-07][AI-08] a pending action is created by the agent with its REVIEW record and decided only by a person with a confirm role', async () => {
  await tx(c, async () => {
    const a = agent();
    const tv = (await c.query("select version_id from core.ai_tool_resolve($1, 'onboarding.tasks.create')", [I.platform])).rows[0].version_id;
    const pid = randomUUID();
    const review = await payload(a, { decision: 'REVIEW', rule_ids: ['AI07-MODE-CONFIRM'], pending_action_id: pid, tool_version_id: tv });
    await append(a, review);
    await refuse(() => as(admin(), 'select core.ai_pending_action_create($1, $2, $3)', [pid, review.id, '{"a":1}']), /created by agents/);
    await refuse(() => as(a, 'select core.ai_pending_action_create($1, $2, $3)', [randomUUID(), review.id, '{"a":1}']), /REVIEW decision record/);
    const p = (await as(a, 'select * from core.ai_pending_action_create($1, $2, $3)', [pid, review.id, '{"a":1}'])).rows[0];
    assert.deepEqual([p.status, p.confirm_roles, p.args_sha256, p.requested_by], ['pending', ['platform_admin', 'platform_ops_manager'], review.inputs_sha256, 'agent:onboarding-planner']);
    const ops = person('demo|ops', ['platform_ops_manager']);
    const allow = await payload(ops, { decision: 'ALLOW', rule_ids: ['AI07-HUMAN-CONFIRMED'], pending_action_id: pid, tool_version_id: tv });
    await append(ops, allow);
    const decide = (claims, status, reason, final) => as(claims, 'select * from core.ai_pending_action_decide($1, $2, $3, $4, $5)', [pid, status, reason, final, '{"ok":true}']);
    await refuse(() => decide(a, 'executed', 'x', allow.id), /only a person/);
    await refuse(() => decide(person('demo|cra', ['cra']), 'executed', 'x', allow.id), /requires one of the roles: platform_admin, platform_ops_manager/);
    await refuse(() => decide(ops, 'executed', ' ', allow.id), /needs a reason/);
    await refuse(() => decide(ops, 'rejected', 'x', allow.id), /final decision record must be/);
    await refuse(() => decide(ops, 'executed', 'x', review.id), /final decision record must be/);
    await refuse(() => decide(person('demo|admin', ['platform_admin']), 'executed', 'x', allow.id), /final decision record must be/);
    await refuse(() => as(ops, "update core.ai_pending_action set status = 'executed' where id = $1", [pid]), /permission denied/);
    const d = (await decide(ops, 'executed', 'plan checked', allow.id)).rows[0];
    assert.deepEqual([d.status, d.decided_by, d.final_decision_id, d.decision_reason, d.result], ['executed', 'demo|ops', allow.id, 'plan checked', { ok: true }]);
    await refuse(() => decide(ops, 'executed', 'again', allow.id), /already executed/);
    await refuse(() => c.query('delete from core.ai_pending_action where id = $1', [pid]), /physical delete not allowed/);
    const audit = (await c.query("select action, reason, actor_sub from core.audit_event where table_name = 'ai_pending_action' and record_id = $1 order by seq", [pid])).rows;
    assert.deepEqual(audit.map(x => [x.action, x.actor_sub, x.reason]), [['INSERT', 'agent:onboarding-planner', null], ['UPDATE', 'demo|ops', 'plan checked']]);
  });
});
