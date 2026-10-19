// CMP-08 (0026): privacy by design — pseudonymous subject codes, re-identification link only in the SAC enclave,
// agreements (DPA/BAA/APPI) per provider before activation, data residency per region, record of processing activities.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

const person = (sub, roles, extra = {}) => ({ sub, roles, platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', actor_type: 'user', ...extra });
const qa = () => person('demo|qa', ['qa_auditor']);
const admin = () => person('demo|admin', ['platform_admin']);
const AS = (claims, reason) => ({ role: 'authenticated', claims, ...(reason ? { reason } : {}) });
const SHA = 'd'.repeat(64);

async function newProvider(code, cats, regions, { gxp = false } = {}) {
  const id = (await c.query(`insert into core.service_provider(code, name, kind, responsibilities, data_categories, processing_regions, gxp_relevant)
    values ($1, $1, 'hosting', 'Hosting of synthetic data', $2, $3, $4) returning id`, [code, cats, regions, gxp])).rows[0].id;
  await c.query("insert into core.provider_oversight_activity(provider_id, kind, performed_on, outcome) values ($1, 'qualification', current_date, 'satisfactory')", [id]);
  await c.query("update core.service_provider set status = 'qualified' where id = $1", [id]);
  return id;
}
const agreement = (id, kind, cats, regions, extra = '') => c.query(`insert into core.provider_agreement(provider_id, kind, data_categories, regions, effective_from,
  document_ref, document_sha256, status ${extra ? ', expires_on' : ''}) values ($1, $2, $3, $4, current_date - 10, 'doc', $5, 'effective' ${extra ? ', ' + extra : ''})`,
[id, kind, cats, regions, SHA]);

test('[CMP-08] the privacy self-check passes on the synthetic platform: pseudonyms, minimisation, enclave, blinding, residency, agreements, ROPA', async () => {
  await tx(c, async () => {
    const rows = (await c.query('select * from core.privacy_check($1)', [I.platform])).rows;
    const failed = rows.filter(r => !r.ok).map(r => `${r.check_code} ${r.subject}: ${r.detail}`);
    assert.deepEqual(failed, []);
    for (const code of ['minimisation.no_direct_identifiers', 'pseudonymisation.subject_codes', 'pseudonymisation.key_in_enclave_only',
      'blinding.subject_arm_not_readable', 'residency.region_declared', 'residency.providers_in_region', 'agreements.valid', 'ropa.recipients_recorded']) {
      assert.ok(rows.some(r => r.check_code === code), `check ${code} is run`);
    }
  }, AS(qa()));
  await tx(c, async () => {
    await rejects(c.query('select * from core.privacy_check($1)', [I.platform]), /qa_auditor or platform_admin/);
  }, AS(person('demo|cra', ['cra'])));
});

test('[CMP-08] the self-check detects an identifier column on participant data (negative control)', async () => {
  await tx(c, async () => {
    await c.query('alter table core.adverse_event add column reporter_phone text');
    const r = (await c.query("select * from core.privacy_check($1) where check_code = 'minimisation.no_direct_identifiers'", [I.platform])).rows[0];
    assert.equal(r.ok, false);
    assert.match(r.detail, /adverse_event\.reporter_phone/);
  }, { claims: qa() });
});

test('[CMP-08] subject codes are pseudonyms: names, e-mails or spaces are refused', async () => {
  for (const code of ['john.smith@example.org', 'Mario Rossi', 'rossi-1970-01-01']) {
    await tx(c, async () => {
      await rejects(c.query("insert into core.subject(platform_id, site_id, subject_code) values ($1, $2, $3)", [I.platform, I.sites[0], code]), /subject_code_pseudonym/);
    }, AS(person('demo|pi101', ['site_pi'])));
  }
  await tx(c, async () => {
    await c.query("insert into core.subject(platform_id, site_id, subject_code) values ($1, $2, '101-900')", [I.platform, I.sites[0]]);
  }, AS(person('demo|pi101', ['site_pi'])));
});

test('[CMP-08][IAM-04] the re-identification link lives only in the enclave: written by the site, read only by the unblinded SAC with a logged reason', async () => {
  await tx(c, async () => {
    const s = (await c.query("select id from core.subject where platform_id = $1 and site_id = $2 limit 1", [I.platform, I.sites[0]])).rows[0].id;
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(person('demo|pi101', ['site_pi'], { site_scopes: [I.sites[0]] }))]);
    const id = (await c.query("select core.register_reidentification($1, 'site', 'site101:econsent:000417', 'kv:trialops-pseudonym-key/1') id", [s])).rows[0].id;
    assert.ok(id);
    // nobody but the enclave function reads it: not the site, not a platform admin, not an agent, not an app
    for (const [role, claims] of [['authenticated', admin()], ['authenticated', { ...admin(), actor_type: 'agent' }], ['app_service', { sub: 'app|x', actor_type: 'app', app_id: 'x' }]]) {
      await c.query('savepoint s');
      await c.query(`set local role ${role}`);
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await rejects(c.query('select * from sac_enclave.reidentification_key'), /permission denied/);
      await c.query('rollback to savepoint s');
    }
    // a blinded person or an agent with the unblinded role is refused; the SAC member reads with a reason, and it is logged
    await c.query('set local role unblinded');
    for (const claims of [{ sub: 'demo|safety', blinding: 'blinded' }, { sub: 'agent:x', actor_type: 'agent', blinding: 'unblinded' }]) {
      await c.query('savepoint t');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await rejects(c.query("select * from sac_enclave.reidentify($1, 'SUSAR follow-up')", [s]), /unblinded SAC persons only/);
      await c.query('rollback to savepoint t');
    }
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: 'demo|sac', blinding: 'unblinded', email: 'sac@demo.trialops.example' })]);
    await c.query('savepoint u');
    await rejects(c.query("select * from sac_enclave.reidentify($1, ' ')", [s]), /needs a reason/);
    await c.query('rollback to savepoint u');
    const r = (await c.query("select * from sac_enclave.reidentify($1, 'SUSAR follow-up requested by the site')", [s])).rows;
    assert.deepEqual(r.map(x => [x.custodian, x.identity_ref]), [['site', 'site101:econsent:000417']]);
    await c.query('reset role');
    const log = (await c.query('select * from core.data_access_log order by seq desc limit 1')).rows[0];
    assert.deepEqual([log.object, log.actor_sub, log.record_id, log.reason], ['sac_enclave.reidentification_key', 'demo|sac', s, 'SUSAR follow-up requested by the site']);
  });
  await tx(c, async () => {
    const s = (await c.query("select id from core.subject where platform_id = $1 and site_id = $2 limit 1", [I.platform, I.sites[1]])).rows[0].id;
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(person('demo|pi101', ['site_pi'], { site_scopes: [I.sites[0]] }))]);
    await rejects(c.query("select core.register_reidentification($1, 'site', 'x', 'k1')", [s]), /perimeter/);
  });
});

test('[CMP-08] a provider with participant data is not activated without a valid DPA/BAA/APPI agreement for each category and region', async () => {
  await tx(c, async () => {
    const id = await newProvider('demo-eu-jp-host', ['pseudonymised_clinical', 'operational'], ['EU', 'JP']);
    const activate = () => c.query("update core.service_provider set status = 'active' where id = $1", [id]);
    await c.query('savepoint a');
    const e = await rejects(activate(), /cannot be active without a valid agreement/);
    assert.match(e.message, /DPA pseudonymised_clinical\/EU/);
    assert.match(e.message, /APPI_TRANSFER pseudonymised_clinical\/JP/);
    await c.query('rollback to savepoint a');
    await agreement(id, 'DPA', ['pseudonymised_clinical'], ['EU']);
    // an expired APPI basis does not count
    await agreement(id, 'APPI_TRANSFER', ['pseudonymised_clinical'], ['JP'], 'current_date - 1');
    await c.query('savepoint b');
    await rejects(activate(), /APPI_TRANSFER pseudonymised_clinical\/JP/);
    await c.query('rollback to savepoint b');
    await agreement(id, 'APPI_TRANSFER', ['pseudonymised_clinical'], ['JP']);
    await activate();
    // widening what an active provider processes needs the agreements too
    await c.query('savepoint c');
    await rejects(c.query("update core.service_provider set processing_regions = '{EU,JP,US}' where id = $1", [id]), /BAA pseudonymised_clinical\/US/);
    await c.query('rollback to savepoint c');
    // an effective agreement cannot be edited, only terminated; it needs the hash of the signed document
    const a = (await c.query("select id from core.provider_agreement where provider_id = $1 and kind = 'DPA'", [id])).rows[0].id;
    await c.query('savepoint d');
    await rejects(c.query("update core.provider_agreement set regions = '{EU,US}' where id = $1", [a]), /cannot be edited/);
    await c.query('rollback to savepoint d');
    await rejects(c.query(`insert into core.provider_agreement(provider_id, kind, data_categories, regions, effective_from, document_ref, status)
      values ($1, 'BAA', '{pseudonymised_clinical}', '{US}', current_date, 'doc', 'effective')`, [id]), /SHA-256 of the signed document/);
  }, AS(qa(), 'provider activation'));
});

test('[CMP-08] data residency: participant data of a platform goes only to providers processing in its region, with agreements; the region is set once', async () => {
  await tx(c, async () => {
    const eu = await newProvider('demo-eu-only', ['pseudonymised_clinical'], ['EU']);
    await agreement(eu, 'DPA', ['pseudonymised_clinical'], ['EU']);
    await c.query("update core.service_provider set status = 'active' where id = $1", [eu]);
    await c.query('savepoint a');
    await rejects(c.query("insert into core.platform_provider(platform_id, provider_id, data_categories, purpose) values ($1, $2, '{pseudonymised_clinical}', 'backup')",
      [I.platform, eu]), /data residency: provider demo-eu-only processes in EU, the platform data stays in US/);
    await c.query('rollback to savepoint a');
    // non-participant data is not bound to the region
    await c.query("update core.service_provider set data_categories = '{pseudonymised_clinical,operational}' where id = $1", [eu]);
    await c.query("insert into core.platform_provider(platform_id, provider_id, data_categories, purpose) values ($1, $2, '{operational}', 'status page')", [I.platform, eu]);
    assert.equal((await c.query("select core.provider_allowed($1, 'demo-eu-only', 'operational') a", [I.platform])).rows[0].a, true);
    assert.equal((await c.query("select core.provider_allowed($1, 'demo-eu-only', 'pseudonymised_clinical') a", [I.platform])).rows[0].a, false);
    assert.equal((await c.query("select core.provider_allowed($1, 'demo-ai-provider', 'pseudonymised_clinical') a", [I.platform])).rows[0].a, true);
    // a US provider without a BAA cannot receive participant data
    const us = await newProvider('demo-us-nobaa', ['pseudonymised_clinical'], ['US']);
    await c.query("insert into core.provider_agreement(provider_id, kind, data_categories, regions, effective_from, document_ref, document_sha256, status) values ($1, 'BAA', '{pseudonymised_clinical}', '{US}', current_date, 'doc', $2, 'effective')", [us, SHA]);
    await c.query("update core.service_provider set status = 'active' where id = $1", [us]);
    await c.query("update core.provider_agreement set status = 'terminated' where provider_id = $1", [us]);
    await c.query('savepoint b');
    await rejects(c.query("insert into core.platform_provider(platform_id, provider_id, data_categories, purpose) values ($1, $2, '{pseudonymised_clinical}', 'x')",
      [I.platform, us]), /no valid agreement for this platform: missing BAA/);
    await c.query('rollback to savepoint b');
    // the self-check reports the terminated agreement of the active provider
    const chk = (await c.query("select * from core.privacy_check($1) where check_code = 'agreements.valid' and subject = 'demo-us-nobaa'", [I.platform])).rows[0];
    assert.equal(chk.ok, false);
    // the region of the platform cannot be moved
    await rejects(c.query("update core.platform set data_region = 'EU' where id = $1", [I.platform]), /set once/);
  }, AS(qa(), 'residency test'));
});

test('[CMP-08] the record of processing activities is versioned data: four eyes, legal basis per region, recipients in the registry, approved versions immutable', async () => {
  const draft = async (version, extra = {}) => (await c.query(`insert into core.ropa_entry(code, version, title, controller, purpose, legal_basis_eu, data_subject_categories,
    data_categories, recipients, regions, retention, security_measures) values ('ROPA-001', $1, 'Platform trials', 'Northfield (fictitious)', 'Trial conduct', $2,
    '{trial participants}', '{pseudonymised_clinical}', $3, $4, '25 years', 'Pseudonymisation, RLS, MFA') returning id`,
  [version, extra.eu ?? null, extra.recipients ?? ['demo-db-hosting'], extra.regions ?? ['US', 'EU']])).rows[0].id;
  await tx(c, async () => {
    await c.query('savepoint a');
    await rejects(draft(1), /next version of ROPA-001 is 2/);
    await c.query('rollback to savepoint a');
    const v2 = await draft(2);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(admin())]);
    await c.query('savepoint b');
    await rejects(c.query("update core.ropa_entry set status = 'approved' where id = $1", [v2]), /legal basis missing for region (US|EU)/);
    await c.query('rollback to savepoint b');
    await c.query("update core.ropa_entry set legal_basis_eu = 'GDPR art. 6(1)(c) and 9(2)(i)', legal_basis_us = 'HIPAA authorization' where id = $1", [v2]);
    await c.query("update core.ropa_entry set status = 'approved' where id = $1", [v2]);
    const rows = (await c.query("select version, status, approved_by from core.ropa_entry where code = 'ROPA-001' order by version")).rows;
    assert.deepEqual(rows.map(r => [r.version, r.status]), [[1, 'superseded'], [2, 'approved']]);
    assert.equal(rows[1].approved_by, 'demo|admin');
    await rejects(c.query("update core.ropa_entry set purpose = 'changed' where id = $1", [v2]), /approved ROPA version is immutable/);
  }, AS(qa(), 'ROPA v2'));
  await tx(c, async () => {
    const v2 = await draft(2, { eu: 'x', regions: ['EU'] });
    await rejects(c.query("update core.ropa_entry set status = 'approved' where id = $1", [v2]), /author of a ROPA version cannot approve it/);
  }, AS(qa(), 'ROPA v2'));
  await tx(c, async () => {
    const v2 = await draft(2, { eu: 'x', regions: ['EU'], recipients: ['not-registered'] });
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(admin())]);
    await rejects(c.query("update core.ropa_entry set status = 'approved' where id = $1", [v2]), /not in the service provider registry: not-registered/);
  }, AS(qa(), 'ROPA v2'));
});
