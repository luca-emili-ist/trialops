// VAL-04 (0026): an L2-L3 app is activated only with an accepted supplier validation package from an active supplier and
// a passing contract test run of the same version; the evidence is stamped on the installation and audited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

const person = (sub, roles) => ({ sub, roles, platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', actor_type: 'user' });
const qa = () => person('demo|qa', ['qa_auditor']);
const admin = () => person('demo|admin', ['platform_admin']);
const AS = (claims, reason) => ({ role: 'authenticated', claims, ...(reason ? { reason } : {}) });
const SHA = 'e'.repeat(64);
const MANIFEST = { app_id: 'ist.edc-l3', version: '2.0.0', publisher: 'InSilicoTrials Technologies', data_residency: ['US'], scopes: ['arm:read'] };

const install = (cls = 'L3', m = MANIFEST) => c.query(`insert into core.app_installation(app_id, version, manifest, gxp_class, platform_id)
  values ($1, $2, $3, $4, $5) returning id`, [m.app_id, m.version, JSON.stringify(m), cls, I.platform]).then(r => r.rows[0].id);
const approve = id => c.query("update core.app_installation set status = 'active', approved_by = 'demo|admin' where id = $1", [id]);
const supplier = async () => (await c.query("select id from core.service_provider where code = 'ist-app-supplier'")).rows[0].id;
const pkg = async (contents = ['URS', 'risk_assessment', 'test_evidence', 'traceability'], version = '2.0.0') =>
  (await c.query(`insert into core.app_validation_package(app_id, version, gxp_class, provider_id, package_uri, package_sha256, contents)
    values ('ist.edc-l3', $1, 'L3', $2, 'https://vp.example/edc-2.0.0.zip', $3, $4) returning id`, [version, await supplier(), SHA, contents])).rows[0].id;
const run = (failed, version = '2.0.0') => c.query(`insert into core.app_contract_test_run(app_id, version, suite, suite_version, passed, failed, evidence_uri, evidence_sha256)
  values ('ist.edc-l3', $1, 'trialops-app-contract', '1.0.0', 40, $2, 'ci://run/1', $3) returning *`, [version, failed, SHA]).then(r => r.rows[0]);

test('[VAL-04] an L3 app is not activated without an accepted validation package and a passing contract test run', async () => {
  await tx(c, async () => {
    const id = await install();
    await c.query('savepoint a');
    const e = await rejects(approve(id), /cannot be activated/);
    assert.match(e.message, /no accepted supplier validation package/);
    assert.match(e.message, /no contract test run/);
    await c.query('rollback to savepoint a');
    const p = await pkg();
    await c.query('savepoint b');
    await rejects(approve(id), /no accepted supplier validation package/, 'received is not accepted');
    await c.query('rollback to savepoint b');
    await c.query("update core.app_validation_package set status = 'accepted', review_note = 'Complete' where id = $1", [p]);
    await run(2);
    await c.query('savepoint c');
    await rejects(approve(id), /latest contract test run failed/);
    await c.query('rollback to savepoint c');
    const ok = await run(0);
    await approve(id);
    const i = (await c.query('select status, validation_package_id, contract_test_run_id from core.app_installation where id = $1', [id])).rows[0];
    assert.deepEqual(i, { status: 'active', validation_package_id: p, contract_test_run_id: ok.id }, 'the evidence is recorded on the installation');
    const audit = (await c.query("select new_row from core.audit_event where table_name = 'app_installation' and record_id = $1 order by seq desc limit 1", [id])).rows[0];
    assert.equal(audit.new_row.validation_package_id, p, 'and in the audit trail');
    assert.equal((await c.query("select core.app_has_scope('ist.edc-l3', $1, 'arm:read') ok", [I.platform])).rows[0].ok, true);
  }, { claims: qa(), reason: 'VAL-04 test' });
});

test('[VAL-04] the gate checks the exact version and an active supplier; L0-L1 apps do not need a package', async () => {
  await tx(c, async () => {
    const p = await pkg(undefined, '1.9.0');
    await c.query("update core.app_validation_package set status = 'accepted', review_note = 'Complete' where id = $1", [p]);
    await run(0, '1.9.0');
    const id = await install();
    await c.query('savepoint a');
    await rejects(approve(id), /no accepted supplier validation package/, 'a package of another version does not count');
    await c.query('rollback to savepoint a');
    const p2 = await pkg();
    await c.query("update core.app_validation_package set status = 'accepted', review_note = 'Complete' where id = $1", [p2]);
    await run(0);
    await c.query("update core.service_provider set status = 'suspended' where code = 'ist-app-supplier'");
    await c.query('savepoint b');
    await rejects(approve(id), /supplier ist-app-supplier is suspended/);
    await c.query('rollback to savepoint b');
    const l1 = await install('L1', { ...MANIFEST, app_id: 'ist.viewer-l1' });
    await approve(l1);
    const g = (await c.query("select * from core.app_validation_gate('ist.viewer-l1', '2.0.0', 'L1')")).rows[0];
    assert.deepEqual([g.required, g.ok], [false, true]);
  }, { claims: qa(), reason: 'VAL-04 test' });
});

test('[VAL-04][CMP-08] the app must keep its data in the region of the platform', async () => {
  await tx(c, async () => {
    const id = await install('L1', { ...MANIFEST, app_id: 'ist.eu-only', data_residency: ['EU'] });
    await rejects(approve(id), /does not keep its data in US/);
  }, { claims: qa(), reason: 'VAL-04 test' });
});

test('[VAL-04] packages are reviewed by QA with a note; L2-L3 packages must be complete; contract test runs are append-only facts', async () => {
  await tx(c, async () => {
    const p = await pkg(['URS', 'test_evidence']);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(admin())]);
    await c.query('savepoint a');
    await rejects(c.query("update core.app_validation_package set status = 'accepted', review_note = 'ok' where id = $1", [p]), /reviewed by QA/);
    await c.query('rollback to savepoint a');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(qa())]);
    await c.query('savepoint b');
    await rejects(c.query("update core.app_validation_package set status = 'accepted' where id = $1", [p]), /needs a note/);
    await c.query('rollback to savepoint b');
    await c.query('savepoint c');
    await rejects(c.query("update core.app_validation_package set status = 'accepted', review_note = 'ok' where id = $1", [p]), /missing risk_assessment, traceability/);
    await c.query('rollback to savepoint c');
    await c.query("update core.app_validation_package set status = 'rejected', review_note = 'Incomplete: no risk assessment' where id = $1", [p]);
    const r = (await c.query('select reviewed_by, reviewed_at from core.app_validation_package where id = $1', [p])).rows[0];
    assert.equal(r.reviewed_by, 'demo|qa');
    assert.ok(r.reviewed_at);
    const t = await run(0);
    assert.deepEqual([t.result, t.recorded_by], ['pass', 'demo|qa']);
    await c.query('savepoint d');
    await rejects(c.query('update core.app_contract_test_run set failed = 0 where id = $1', [t.id]), /append-only|permission denied/);
    await c.query('rollback to savepoint d');
    const none = (await c.query(`insert into core.app_contract_test_run(app_id, version, suite, suite_version, passed, failed, evidence_uri, evidence_sha256)
      values ('ist.edc-l3', '2.0.1', 'trialops-app-contract', '1.0.0', 0, 0, 'ci://run/2', $1) returning result`, [SHA])).rows[0];
    assert.equal(none.result, 'fail', 'a run without passed tests is not a pass');
  }, AS(qa(), 'package review'));
  for (const claims of [person('demo|ops', ['platform_ops_manager']), { ...qa(), actor_type: 'agent' }]) {
    await tx(c, async () => {
      await rejects(pkg(), /maintained by a person with role/);
    }, AS(claims));
  }
});
