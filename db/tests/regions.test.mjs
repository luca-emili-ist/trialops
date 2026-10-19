// NFR-06 (0028): one database serves one data region. Its region is set once by the owner; once set, no platform of
// another region can be created or moved there; refused cross-region requests are recorded append-only and audited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

/** Expects a refusal without aborting the surrounding test transaction. */
async function refused(run, re) {
  await c.query('savepoint refuse');
  try { await rejects(run(), re); } finally { await c.query('rollback to savepoint refuse'); }
}
const person = (sub, roles) => ({ sub, roles, platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', actor_type: 'user', email: `${sub.slice(5)}@demo.trialops.example` });
const lead = async () => (await c.query("select lead_operator_id id from core.platform where code = 'PLAT-001'")).rows[0].id;
const newPlatform = async (code, region) => (await c.query(`insert into core.platform(code, title, therapeutic_area, lead_operator_id, status, data_region)
  values ($1, 'Synthetic regional platform', 'Disease Y (fictitious)', $2, 'active', $3) returning id, data_region`, [code, await lead(), region])).rows[0];

test('[NFR-06] the region of a database is set once by the owner and never changed; API roles cannot set it', async () => {
  await tx(c, async () => {
    assert.equal((await c.query('select core.deployment_region() r')).rows[0].r, null, 'a fresh database has no region');
    // the synthetic platform is US: a database that holds it cannot become an EU deployment
    await refused(() => c.query("select core.set_deployment_region('EU')"), /holds platforms of another region: PLAT-001 \(US\)/);
    await refused(() => c.query("select core.set_deployment_region('XX')"), /EU, US or JP/);
    assert.equal((await c.query("select core.set_deployment_region('US', 'US deployment of the synthetic demo') r")).rows[0].r, 'US');
    assert.equal((await c.query("select core.set_deployment_region('US') r")).rows[0].r, 'US', 'idempotent for the same region');
    await refused(() => c.query("select core.set_deployment_region('JP')"), /set once: this database serves US/);
    await refused(() => c.query("update core.deployment set region = 'JP'"), /set once/);
    await refused(() => c.query('delete from core.deployment'), /physical delete not allowed/);
    const a = (await c.query("select action, new_row->>'region' region from core.audit_event where table_name = 'deployment' order by seq desc limit 1")).rows[0];
    assert.deepEqual(a, { action: 'INSERT', region: 'US' }, 'the setting is in the audit trail');
  });
  await tx(c, async () => {
    await refused(() => c.query("select core.set_deployment_region('US')"), /permission denied/);
    await refused(() => c.query('select * from core.deployment'), /permission denied/);
    assert.equal((await c.query('select core.deployment_region() r')).rows[0].r, null, 'readable by the API roles');
  }, { role: 'authenticated', claims: person('demo|admin', ['platform_admin']) });
});

test('[NFR-06] once the database has a region, platforms of another region can be neither created nor moved there', async () => {
  await tx(c, async () => {
    await c.query("select core.set_deployment_region('US')");
    await refused(() => newPlatform('PLAT-EU1', 'EU'), /keeps its data in EU: it cannot be stored in the US deployment/);
    await refused(() => newPlatform('PLAT-JP1', 'JP'), /keeps its data in JP/);
    assert.equal((await newPlatform('PLAT-US2', null)).data_region, 'US', 'a new platform takes the region of the deployment');
    assert.equal((await newPlatform('PLAT-US3', 'US')).data_region, 'US');
  });
  await tx(c, async () => {
    // without a deployment region (shared transitional database) platforms of every region can exist: the API gate applies
    assert.equal((await newPlatform('PLAT-EU2', 'EU')).data_region, 'EU');
    assert.equal((await newPlatform('PLAT-JP2', 'JP')).data_region, 'JP');
  });
});

test('[NFR-06] regions of the platforms for the API gate: id, code and region only', async () => {
  await tx(c, async () => {
    const eu = await newPlatform('PLAT-EU3', 'EU');
    await c.query('set local role authenticated');
    const rows = (await c.query('select * from core.platform_regions($1)', [[I.platform, eu.id]])).rows;
    assert.deepEqual(rows.map(r => [r.code, r.data_region]).sort(), [['PLAT-001', 'US'], ['PLAT-EU3', 'EU']]);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['code', 'data_region', 'id']);
    assert.ok((await c.query('select * from core.platform_regions(null)')).rows.length >= 2, 'all platforms when no id is given');
  }, { claims: person('demo|ops', ['platform_ops_manager']) });
});

test('[NFR-06] a refused cross-region request is recorded append-only with actor and server time, audited, read by QA and admins only', async () => {
  await tx(c, async () => {
    const eu = await newPlatform('PLAT-EU4', 'EU');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(person('demo|cra', ['cra']))]);
    await c.query('set local role authenticated');
    const id = (await c.query("select core.log_region_refusal('US', $1, 'EU', 'get', '/v1/platforms/x') id", [eu.id])).rows[0].id;
    await refused(() => c.query('select * from core.region_access_refusal'), /permission denied/);
    await refused(() => c.query('select * from core.region_refusal_search()'), /qa_auditor or platform_admin/);
    await c.query('reset role');
    const r = (await c.query('select * from core.region_access_refusal where id = $1', [id])).rows[0];
    assert.equal(r.actor_sub, 'demo|cra');
    assert.equal(r.actor_email, 'cra@demo.trialops.example');
    assert.deepEqual([r.deployment_region, r.platform_region, r.method], ['US', 'EU', 'GET']);
    assert.ok(Math.abs(Date.now() - r.occurred_at.getTime()) < 120_000, 'server time');
    assert.equal((await c.query("select count(*)::int n from core.audit_event where table_name = 'region_access_refusal' and record_id = $1", [id])).rows[0].n, 1);
    await refused(() => c.query('update core.region_access_refusal set path = $2 where id = $1', [id, '/x']), /append-only|immutable/i);
    await refused(() => c.query('delete from core.region_access_refusal where id = $1', [id]), /append-only|immutable/i);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(person('demo|qa', ['qa_auditor']))]);
    await c.query('set local role authenticated');
    assert.ok((await c.query('select * from core.region_refusal_search(10)')).rows.some(x => x.id === id));
  });
});
