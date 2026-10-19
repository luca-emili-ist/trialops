// Native EDC (module M06b, migration 0027): scripted tests of EDC-01, EDC-03, EDC-04, EDC-05, EDC-11, EDC-12.
// Every test runs in a transaction that is rolled back, on the seeded synthetic database (db/seed/seed-edc.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, rejects } from './_helpers.mjs';
let c, P, S101, S102, SUBJ, VS, IE, V;
before(async () => {
  c = await db();
  P = (await c.query("select id from core.platform where code = 'PLAT-001'")).rows[0].id;
  const site = n => c.query('select id from core.site where platform_id = $1 and site_number = $2', [P, n]).then(r => r.rows[0].id);
  S101 = await site('101'); S102 = await site('102');
  // subjects of site 101 not used by the seed (the seed uses the first three on treatment)
  SUBJ = (await c.query(`select id from core.subject where site_id = $1 and status = 'on_treatment' order by subject_code offset 3 limit 3`, [S101])).rows.map(r => r.id);
  VS = (await c.query("select id from core.crf_form where platform_id = $1 and oid = 'F.VS'", [P])).rows[0].id;
  IE = (await c.query("select id from core.crf_form where platform_id = $1 and oid = 'F.IE'", [P])).rows[0].id;
  V = Object.fromEntries((await c.query('select code, id from core.visit_definition where platform_id = $1', [P])).rows.map(r => [r.code, r.id]));
});
after(async () => c.end());

const person = (sub, roles, extra = {}) => ({ sub, actor_type: 'user', platform_ids: [P], arm_scopes: '*', site_scopes: '*', roles, ...extra });
const PI = () => person('demo|pi101', ['site_pi'], { site_scopes: [S101] });
const PI102 = () => person('demo|pi102', ['site_pi'], { site_scopes: [S102] });
const DM = () => person('demo|dm', ['data_manager']);
const CRA = () => person('demo|cra', ['cra']);
const ADMIN = () => person('demo|admin', ['platform_admin']);

// One transaction, rolled back. `as(claims, reason)` switches the caller (role authenticated, or app_service for apps).
async function scenario(fn) {
  await c.query('begin');
  try {
    const as = async (claims, reason = null, role = 'authenticated') => {
      await c.query('reset role');
      await c.query("select set_config('request.jwt.claims', $1, true), set_config('trialops.change_reason', $2, true)",
        [claims ? JSON.stringify(claims) : '', reason ?? '']);
      if (claims) await c.query(`set local role ${role}`);
    };
    const one = async (sql, args) => (await c.query(sql, args)).rows[0];
    // a mistake inside the scenario must not abort the transaction for the next statement
    const refused = async (sql, args, re) => {
      await c.query('savepoint r');
      try { return await rejects(c.query(sql, args), re); } finally { await c.query('rollback to savepoint r'); }
    };
    return await fn({ as, one, refused });
  } finally { await c.query('rollback'); }
}

async function visitWithVs(h, subject = SUBJ[0], code = 'W12', date = '2026-10-16') {
  await h.as(PI());
  const sv = await h.one('insert into core.subject_visit(subject_id, visit_definition_id, visit_date) values ($1,$2,$3) returning *', [subject, V[code], date]);
  const e = await h.one('insert into core.crf_entry(subject_visit_id, crf_form_id) values ($1,$2) returning *', [sv.id, VS]);
  return { sv, e };
}
const put = (entry, oid, value, missing = null) => c.query(`insert into core.item_value(crf_entry_id, item_oid, value, missing_reason)
  values ($1,$2,$3,$4) returning *`, [entry, oid, value, missing]).then(r => r.rows[0]);
const queries = entry => c.query('select q.*, k.code check_code from core.edc_query q left join core.crf_edit_check k on k.id = q.edit_check_id where crf_entry_id = $1 order by k.code', [entry]).then(r => r.rows);

// ===================================================================================================================
// EDC-01 · versioned CRF library linked to protocol visits
// ===================================================================================================================
test('[EDC-01] the CRF library is versioned and linked to the visits of the approved Master Protocol', async () => {
  const forms = (await c.query(`select f.oid, v.version_no, v.status, v.approved_signature_id is not null signed,
      (select array_agg(d.code order by d.ordinal) from core.crf_visit l join core.visit_definition d on d.id = l.visit_definition_id where l.crf_version_id = v.id) visits
    from core.crf_form f join core.crf_version v on v.form_id = f.id where f.platform_id = $1 order by f.oid, v.version_no`, [P])).rows;
  assert.deepEqual(forms.map(f => [f.oid, f.version_no, f.status, f.signed]),
    [['F.IE', 1, 'approved', true], ['F.VS', 1, 'approved', true], ['F.VS', 2, 'draft', false]]);
  assert.deepEqual(forms[1].visits, ['SCR', 'BL', 'W4', 'W12']);
  const vd = (await c.query(`select d.code, m.status, m.platform_id = d.platform_id same from core.visit_definition d
    join core.master_protocol_version m on m.id = d.master_protocol_version_id where d.platform_id = $1`, [P])).rows;
  assert.ok(vd.length === 4 && vd.every(r => r.status === 'approved' && r.same));
  // CDASH-like metadata: ODM OIDs, CDASH variable, units as codelist terms (rule 13)
  const items = (await c.query(`select i.oid, i.cdash_variable, i.data_type, t.submission_value unit, l.code codelist from core.crf_item i
    join core.crf_version v on v.id = i.crf_version_id left join core.codelist_term t on t.id = i.unit_term_id left join core.codelist l on l.id = i.codelist_id
    where v.form_id = $1 and v.version_no = 1 order by i.ordinal`, [VS])).rows;
  assert.deepEqual(items.map(i => [i.oid, i.cdash_variable, i.unit ?? i.codelist]),
    [['I.VS.SYSBP', 'SYSBP', 'mmHg'], ['I.VS.DIABP', 'DIABP', 'mmHg'], ['I.VS.PULSE', 'PULSE', 'beats/min'], ['I.VS.VSPOS', 'VSPOS', 'VSPOS']]);
});

test('[EDC-01] an approved CRF version and its items, checks and visit links are immutable: a new version instead', async () => {
  await scenario(async h => {
    const v1 = await h.one("select id from core.crf_version where form_id = $1 and status = 'approved'", [VS]);
    await h.as(DM(), 'try to edit an approved version');
    await h.refused("insert into core.crf_item(crf_version_id, oid, cdash_variable, label, data_type) values ($1, 'I.VS.TEMP', 'TEMP', 'Temperature', 'decimal')", [v1.id], /approved versions are immutable/);
    await h.refused("update core.crf_item set label = 'Changed' where crf_version_id = $1", [v1.id], /approved versions are immutable/);
    await h.refused("update core.crf_edit_check set max_value = 300 where crf_version_id = $1 and kind = 'range'", [v1.id], /approved versions are immutable/);
    await h.refused("update core.crf_visit set status = 'void' where crf_version_id = $1", [v1.id], /approved versions are immutable/);
    await h.refused("update core.crf_version set status = 'draft' where id = $1", [v1.id], /not allowed/);
    await h.refused('delete from core.crf_item where crf_version_id = $1', [v1.id], /physical delete not allowed|permission denied/);
    const v3 = await h.one('insert into core.crf_version(form_id) values ($1) returning *', [VS]);
    assert.equal(v3.version_no, 3);
    assert.equal(v3.status, 'draft');
  });
});

test('[EDC-01][CMP-02][IAM-05] approval needs an approval signature on the version, never by an author; the previous version is superseded', async () => {
  await scenario(async h => {
    const v2 = await h.one("select id from core.crf_version where form_id = $1 and version_no = 2", [VS]);
    const sig = async (signer, target) => (await h.one(`insert into core.signature(signer_sub, signer_name, meaning, target_table, target_id, target_hash, auth_method)
      values ($1, $1, 'approval', 'crf_version', $2, 'h', 'reauth_mfa') returning id`, [signer, target])).id;
    await h.as(null);
    const own = await sig('demo|dm', v2.id);     // demo|dm authored the version (seed)
    const other = await sig('demo|admin', v2.id);
    const wrong = await sig('demo|admin', (await h.one("select id from core.crf_version where form_id = $1 and version_no = 1", [IE])).id);
    await h.as(ADMIN(), 'approve v2');
    await h.refused("update core.crf_version set status = 'approved' where id = $1", [v2.id], /approval signature/);
    await h.refused("update core.crf_version set status = 'approved', approved_signature_id = $2 where id = $1", [v2.id, wrong], /approval signature on that version/);
    await h.refused("update core.crf_version set status = 'approved', approved_signature_id = $2 where id = $1", [v2.id, own], /separation of duties/);
    await h.as(CRA(), 'approve v2');
    await h.refused("update core.crf_version set status = 'approved', approved_signature_id = $2 where id = $1", [v2.id, other], /data_manager or platform_admin/);
    await h.as(ADMIN(), 'approve v2');
    const ok = await h.one("update core.crf_version set status = 'approved', approved_signature_id = $2 where id = $1 returning status, approved_at", [v2.id, other]);
    assert.equal(ok.status, 'approved');
    assert.ok(ok.approved_at);
    const all = (await c.query('select version_no, status from core.crf_version where form_id = $1 order by version_no', [VS])).rows;
    assert.deepEqual(all.map(r => r.status), ['superseded', 'approved']);
    await h.as(null);
    assert.equal((await h.one("select count(*)::int n from core.event_outbox where type = 'edc.crf.version.approved' and subject = $1", [`crf_version/${v2.id}`])).n, 1);
    // data already entered stays bound to version 1
    assert.ok((await h.one("select count(*)::int n from core.crf_entry e join core.crf_version v on v.id = e.crf_version_id where v.form_id = $1 and v.version_no = 1", [VS])).n > 0);
  });
});

test('[EDC-01] terminology comes only from versioned codelists (rule 13): coded items, units and approved codelists are checked', async () => {
  await scenario(async h => {
    await h.as(DM(), 'library work');
    const v = await h.one('insert into core.crf_version(form_id) values ($1) returning id', [VS]);
    const draftList = await h.one("insert into core.codelist(platform_id, code, name, dictionary, dictionary_version) values ($1, 'LOC', 'Location', 'CDISC-CT', 'test') returning id", [P]);
    await h.refused("insert into core.crf_item(crf_version_id, oid, cdash_variable, label, data_type) values ($1, 'I.VS.LOC', 'VSLOC', 'Location', 'coded')", [v.id], /check constraint/);
    await h.refused("insert into core.crf_item(crf_version_id, oid, cdash_variable, label, data_type, codelist_id) values ($1, 'I.VS.LOC', 'VSLOC', 'Location', 'coded', $2)",
      [v.id, draftList.id], /approved codelist/);
    const ny = await h.one("select t.id from core.codelist_term t join core.codelist l on l.id = t.codelist_id where l.code = 'NY' and t.submission_value = 'Y'");
    await h.refused("insert into core.crf_item(crf_version_id, oid, cdash_variable, label, data_type, unit_term_id) values ($1, 'I.VS.TEMP', 'TEMP', 'Temperature', 'decimal', $2)",
      [v.id, ny.id], /UNIT codelist/);
    const nyList = await h.one("select id from core.codelist where platform_id = $1 and code = 'NY'", [P]);
    await h.refused("insert into core.codelist_term(codelist_id, submission_value, decode) values ($1, 'U', 'Unknown')", [nyList.id], /draft codelist/);
    await h.refused("update core.codelist_term set decode = 'Yes!' where id = $1", [ny.id], /append-only|permission denied/);
    await h.refused("update core.codelist set name = 'Other' where id = $1", [nyList.id], /immutable/);
    await h.refused("update core.codelist set status = 'approved' where id = $1", [draftList.id], /at least one term/);
    await h.as(CRA(), 'library work');
    await h.refused("insert into core.crf_form(platform_id, oid, name) values ($1, 'F.AE', 'Adverse events')", [P], /data_manager or platform_admin/);
  });
});

// ===================================================================================================================
// EDC-03 · site data entry
// ===================================================================================================================
test('[EDC-03] site staff enter values; author and time are the server UTC clock, platform/site/subject come from the visit', async () => {
  await scenario(async h => {
    const { sv, e } = await visitWithVs(h);
    assert.equal(sv.site_id, S101);
    assert.equal(e.status, 'in_progress');
    const before = await h.one('select clock_timestamp() t');
    const v = await h.one(`insert into core.item_value(crf_entry_id, item_oid, value, entered_by, entered_at, site_id, source)
      values ($1, 'I.VS.SYSBP', ' 0120 ', 'someone-else', '2000-01-01T00:00:00Z', $2, 'app') returning *`, [e.id, S102]);
    assert.equal(v.entered_by, 'demo|pi101');
    assert.ok(v.entered_at >= before.t, 'server time, not the supplied one');
    assert.equal(v.site_id, S101);
    assert.equal(v.source, 'site_entry');
    assert.equal(v.value, '120');
    assert.equal(Number(v.value_num), 120);
    assert.equal(v.source_app, null, 'a person cannot claim app provenance');
  });
});

test('[EDC-03] values are typed; coded values come from the codelist; ND/NA/UNK record missing data, never with a value', async () => {
  await scenario(async h => {
    const { e } = await visitWithVs(h);
    await h.refused("insert into core.item_value(crf_entry_id, item_oid, value) values ($1, 'I.VS.SYSBP', '12O')", [e.id], /not an integer/);
    await h.refused("insert into core.item_value(crf_entry_id, item_oid, value) values ($1, 'I.VS.VSPOS', 'LYING')", [e.id], /not a term of its codelist/);
    await h.refused("insert into core.item_value(crf_entry_id, item_oid, value, missing_reason) values ($1, 'I.VS.PULSE', '70', 'ND')", [e.id], /not both/);
    await h.refused("insert into core.item_value(crf_entry_id, item_oid) values ($1, 'I.VS.PULSE')", [e.id], /value or a missing-data reason/);
    await h.refused("insert into core.item_value(crf_entry_id, item_oid, value) values ($1, 'I.VS.WEIGHT', '70')", [e.id], /not in the CRF version/);
    const nd = await put(e.id, 'I.VS.PULSE', null, 'ND');
    assert.equal(nd.missing_reason, 'ND');
    assert.equal((await put(e.id, 'I.VS.VSPOS', 'SUPINE')).value, 'SUPINE');
  });
});

test('[EDC-03][DM-03] a change needs a reason; the prior value, author, server time and reason stay in the history', async () => {
  await scenario(async h => {
    const { e } = await visitWithVs(h);
    const v = await put(e.id, 'I.VS.DIABP', '81');
    await h.refused("update core.item_value set value = '82' where id = $1", [v.id], /change reason required/);
    await h.as(PI(), 'Transcription error, source says 82');
    const u = await h.one("update core.item_value set value = '82' where id = $1 returning *", [v.id]);
    assert.equal(u.value, '82');
    assert.equal(u.row_version, 2);
    const hist = (await c.query('select * from core.item_value_history($1)', [v.id])).rows;
    assert.deepEqual(hist.map(r => [r.action, r.value, r.reason, r.actor_sub]),
      [['INSERT', '81', null, 'demo|pi101'], ['UPDATE', '82', 'Transcription error, source says 82', 'demo|pi101']]);
    await h.refused('delete from core.item_value where id = $1', [v.id], /physical delete not allowed|permission denied/);
    await h.as(PI102());
    await h.refused('select * from core.item_value_history($1)', [v.id], /outside your perimeter/);
  });
});

test('[EDC-03] only the site enters data; the investigator keeps access to the data of the site, other sites and sponsors do not see it', async () => {
  await scenario(async h => {
    const { e } = await visitWithVs(h);
    await put(e.id, 'I.VS.SYSBP', '120');
    await h.as(DM());
    await h.refused("insert into core.item_value(crf_entry_id, item_oid, value) values ($1, 'I.VS.DIABP', '80')", [e.id], /entered and corrected by the site/);
    assert.ok((await h.one('select count(*)::int n from core.item_value where site_id = $1', [S101])).n > 0, 'the data manager reviews the data');
    await h.as(PI());
    const own = await h.one('select count(*)::int n, count(distinct site_id)::int sites from core.item_value');
    assert.ok(own.n > 10); assert.equal(own.sites, 1);
    await h.as(PI102());
    assert.equal((await h.one('select count(*)::int n from core.item_value where site_id = $1', [S101])).n, 0);
    await h.refused("insert into core.item_value(crf_entry_id, item_oid, value) values ($1, 'I.VS.DIABP', '80')", [e.id], /form entry not found|row-level security/);
    const arm = await h.one("select id from core.arm where code = 'ARM-A'");
    await h.as(person('demo|arden', ['arm_sponsor_lead'], { arm_scopes: [arm.id] }));
    for (const t of ['subject_visit', 'crf_entry', 'item_value', 'edc_query', 'v_visit_data_collection'])
      assert.equal((await h.one(`select count(*)::int n from core.${t}`)).n, 0, `sponsor reads ${t}`);
  });
});

test('[EDC-03][APP-DT-05] an app writes values only with the scope edc.data:write and with provenance', async () => {
  await scenario(async h => {
    const { e } = await visitWithVs(h);
    await h.as(null, 'test app installation');
    const inst = await h.one(`insert into core.app_installation(app_id, version, gxp_class, platform_id, manifest) values ('test.edc-device', '1.0.0', 'L1', $1,
      '{"scopes": ["edc.data:write"], "data_residency": ["US"]}') returning id`, [P]);
    const app = { sub: 'app:test.edc-device', actor_type: 'app', app_id: 'test.edc-device', platform_ids: [P], arm_scopes: '*', site_scopes: '*' };
    await h.as(app, null, 'app_service');
    await h.refused("insert into core.item_value(crf_entry_id, item_oid, value) values ($1, 'I.VS.PULSE', '70')", [e.id], /edc.data:write|form entry not found/);
    await h.as(null, 'activate');
    await c.query("update core.app_installation set status = 'active', approved_by = 'demo|admin' where id = $1", [inst.id]);
    await h.as(app, null, 'app_service');
    await h.refused("insert into core.item_value(crf_entry_id, item_oid, value) values ($1, 'I.VS.PULSE', '70')", [e.id], /without provenance/);
    await c.query("select set_config('trialops.provenance', $1, true)", [JSON.stringify({ source_record_id: 'dev-42', source_version: '3', transformation_id: 'bp-cuff-v1' })]);
    const v = await h.one("insert into core.item_value(crf_entry_id, item_oid, value) values ($1, 'I.VS.PULSE', '70') returning *", [e.id]);
    assert.deepEqual([v.source, v.source_app, v.source_record_id, v.entered_by], ['app', 'test.edc-device', 'dev-42', 'app:test.edc-device']);
  });
});

test('[EDC-03] visits are recorded for consented subjects, never in the future (UTC), and are completed only when every scheduled form is complete', async () => {
  await scenario(async h => {
    await h.as(PI());
    await h.refused("insert into core.subject_visit(subject_id, visit_definition_id, visit_date) values ($1, $2, (current_date + 2))", [SUBJ[1], V.W12], /future/);
    const ident = await h.one("select id from core.subject_blinded where site_id = $1 and status = 'identified' limit 1", [S101]);
    await h.refused("insert into core.subject_visit(subject_id, visit_definition_id, visit_date) values ($1, $2, '2026-10-01')", [ident.id, V.SCR], /consented subjects/);
    const scr = await h.one("insert into core.subject_visit(subject_id, visit_definition_id, visit_date) values ($1, $2, '2026-10-10') returning id", [SUBJ[1], V.SCR]);
    await h.refused("insert into core.subject_visit(subject_id, visit_definition_id, visit_date) values ($1, $2, '2026-10-11')", [SUBJ[1], V.SCR], /duplicate key/);
    await h.as(PI(), 'complete');
    await h.refused("update core.subject_visit set status = 'completed' where id = $1", [scr.id], /forms not complete: F.IE, F.VS/);
    await h.refused("insert into core.crf_entry(subject_visit_id, crf_form_id, crf_version_id) values ($1, $2, (select id from core.crf_version where form_id = $2 and version_no = 2))",
      [scr.id, VS], /approved CRF version/);
  });
});

// ===================================================================================================================
// EDC-04 · declarative edit checks
// ===================================================================================================================
test('[EDC-04] a failing soft range check opens one query; a passing value after a change closes it with the reason', async () => {
  await scenario(async h => {
    const { e } = await visitWithVs(h);
    const v = await put(e.id, 'I.VS.SYSBP', '255');
    let q = await queries(e.id);
    assert.deepEqual(q.map(x => [x.check_code, x.status, x.origin, x.opened_by]), [['EC.VS.SYSBP.RANGE', 'open', 'edit_check', 'demo|pi101']]);
    assert.equal(q[0].item_value_id, v.id);
    assert.match(q[0].question, /outside 60-250/);
    await h.as(PI(), 'Rechecked: 256 per source');
    await c.query("update core.item_value set value = '256' where id = $1", [v.id]);
    assert.equal((await queries(e.id)).length, 1, 'no duplicate query for the same check');
    await h.as(PI(), 'Transcription error: 156 per source');
    await c.query("update core.item_value set value = '156' where id = $1", [v.id]);
    q = await queries(e.id);
    assert.equal(q[0].status, 'closed');
    assert.match(q[0].close_reason, /Resolved by data change: edit check EC.VS.SYSBP.RANGE passes/);
    await h.as(null);
    const audit = await h.one("select reason, actor_sub from core.audit_event where table_name = 'edc_query' and record_id = $1 and action = 'UPDATE' order by seq desc limit 1", [q[0].id]);
    assert.equal(audit.actor_sub, 'demo|pi101');
    assert.match(audit.reason, /passes after the data change/);
  });
});

test('[EDC-04] a hard check refuses the value; the cross-field compare check opens a query', async () => {
  await scenario(async h => {
    const { e } = await visitWithVs(h);
    await h.refused("insert into core.item_value(crf_entry_id, item_oid, value) values ($1, 'I.VS.PULSE', '400')", [e.id], /hard edit check EC.VS.PULSE.LIMIT failed/);
    assert.equal((await h.one('select count(*)::int n from core.item_value where crf_entry_id = $1', [e.id])).n, 0, 'nothing stored');
    await put(e.id, 'I.VS.SYSBP', '100');
    await put(e.id, 'I.VS.DIABP', '100');
    assert.deepEqual((await queries(e.id)).map(q => q.check_code), ['EC.VS.BP.ORDER']);
  });
});

test('[EDC-04] required checks at completion: a hard one refuses, a soft one opens a query; ND counts as an answer', async () => {
  await scenario(async h => {
    const { sv, e } = await visitWithVs(h, SUBJ[2], 'SCR', '2026-10-12');
    const ie = await h.one('insert into core.crf_entry(subject_visit_id, crf_form_id) values ($1,$2) returning id', [sv.id, IE]);
    await h.as(PI(), 'complete');
    await h.refused("update core.crf_entry set status = 'complete' where id = $1", [ie.id], /hard edit check EC.IE.IEYN.REQ failed/);
    await put(e.id, 'I.VS.DIABP', '70');
    const done = await h.one("update core.crf_entry set status = 'complete' where id = $1 returning status, completed_at, completed_by", [e.id]);
    assert.equal(done.status, 'complete'); assert.equal(done.completed_by, 'demo|pi101');
    assert.deepEqual((await queries(e.id)).map(q => [q.check_code, q.status]), [['EC.VS.SYSBP.REQ', 'open']]);
    await put(e.id, 'I.VS.SYSBP', null, 'ND');
    assert.deepEqual((await queries(e.id)).map(q => [q.check_code, q.status]), [['EC.VS.SYSBP.REQ', 'closed']]);
  });
});

test('[EDC-04] batch evaluation is deterministic: the same data give the same queries, never duplicates', async () => {
  await scenario(async h => {
    const { e } = await visitWithVs(h);
    await put(e.id, 'I.VS.SYSBP', '90'); await put(e.id, 'I.VS.DIABP', '95');
    const first = (await queries(e.id)).map(q => q.check_code);
    await h.as(DM());
    assert.equal((await h.one('select core.edc_run_checks($1) n', [e.id])).n, 0);
    assert.equal((await h.one('select core.edc_run_checks($1) n', [e.id])).n, 0);
    assert.deepEqual((await queries(e.id)).map(q => q.check_code), first);
    await h.as(person('demo|arden', ['arm_sponsor_lead']));
    await h.refused('select core.edc_run_checks($1)', [e.id], /not found/);
    await h.as(PI102());
    await h.refused("select core.edc_evaluate($1, 'batch')", [e.id], /outside your perimeter/);
  });
});

test('[EDC-04] checks are declared as data on the version and validated: unknown items and wrong types are refused', async () => {
  await scenario(async h => {
    await h.as(DM(), 'library');
    const v = await h.one('insert into core.crf_version(form_id) values ($1) returning id', [VS]);
    await c.query("insert into core.crf_item(crf_version_id, oid, cdash_variable, label, data_type) values ($1, 'I.VS.VSDTC', 'VSDAT', 'Date', 'date')", [v.id]);
    await c.query("insert into core.crf_item(crf_version_id, oid, cdash_variable, label, data_type) values ($1, 'I.VS.SYSBP', 'SYSBP', 'SBP', 'integer')", [v.id]);
    await h.refused("insert into core.crf_edit_check(crf_version_id, code, kind, item_oid, min_value, message) values ($1, 'EC.X', 'range', 'I.VS.NOPE', 1, 'x')", [v.id], /not in the version/);
    await h.refused("insert into core.crf_edit_check(crf_version_id, code, kind, item_oid, min_value, message) values ($1, 'EC.X', 'range', 'I.VS.VSDTC', 1, 'x')", [v.id], /numeric items/);
    await h.refused("insert into core.crf_edit_check(crf_version_id, code, kind, item_oid, operator, other_item_oid, message) values ($1, 'EC.X', 'compare', 'I.VS.VSDTC', '<', 'I.VS.SYSBP', 'x')", [v.id], /two numeric or two date/);
    await h.refused("insert into core.crf_edit_check(crf_version_id, code, kind, item_oid, message) values ($1, 'EC.X', 'range', 'I.VS.SYSBP', 'x')", [v.id], /check constraint/);
  });
});

// ===================================================================================================================
// EDC-05 · query workflow
// ===================================================================================================================
test('[EDC-05] open -> answered by the site -> closed by the data manager; terminal; times and authors from the server', async () => {
  await scenario(async h => {
    const { e } = await visitWithVs(h);
    await put(e.id, 'I.VS.SYSBP', '255');
    const q = (await queries(e.id))[0];
    await h.as(PI(), 'answer');
    await h.refused("update core.edc_query set status = 'closed', close_reason = 'ok' where id = $1", [q.id], /data manager or a monitor/);
    await h.refused("update core.edc_query set status = 'answered' where id = $1", [q.id], /answer is required/);
    const a = await h.one("update core.edc_query set status = 'answered', answer = 'Confirmed against source', answered_by = 'x', answered_at = '2000-01-01' where id = $1 returning *", [q.id]);
    assert.equal(a.answered_by, 'demo|pi101'); assert.ok(a.answered_at > new Date('2026-01-01'));
    await h.as(DM(), 'close');
    await h.refused("update core.edc_query set status = 'closed' where id = $1", [q.id], /reason is required/);
    await h.refused("update core.edc_query set question = 'other' where id = $1", [q.id], /cannot change/);
    const cl = await h.one("update core.edc_query set status = 'closed', close_reason = 'Answer accepted' where id = $1 returning *", [q.id]);
    assert.deepEqual([cl.status, cl.closed_by, cl.answer], ['closed', 'demo|dm', 'Confirmed against source']);
    await h.refused("update core.edc_query set status = 'open' where id = $1", [q.id], /not allowed/);
    await h.refused('delete from core.edc_query where id = $1', [q.id], /physical delete not allowed|permission denied/);
    await h.as(null);
    const trail = (await c.query("select action, new_row->>'status' s, reason from core.audit_event where table_name = 'edc_query' and record_id = $1 order by seq", [q.id])).rows;
    assert.deepEqual(trail.map(t => t.s), ['open', 'answered', 'closed']);
    assert.equal(trail[2].reason, 'close');
  });
});

test('[EDC-05] manual queries by data managers and monitors; re-query and cancel; agents and the site cannot open queries', async () => {
  await scenario(async h => {
    const { e } = await visitWithVs(h);
    const v = await put(e.id, 'I.VS.PULSE', '72');
    const ins = "insert into core.edc_query(crf_entry_id, item_value_id, origin, question) values ($1, $2, 'manual', 'Please confirm the position') returning *";
    await h.refused(ins, [e.id, v.id], /data manager or a monitor/);
    await h.as(person('agent:data-reviewer', ['data_manager'], { actor_type: 'agent' }));
    await h.refused(ins, [e.id, v.id], /data manager or a monitor|row-level security|not found/);
    await h.as(CRA());
    await h.refused("insert into core.edc_query(crf_entry_id, origin, question, edit_check_id) values ($1, 'edit_check', 'x', (select id from core.crf_edit_check limit 1))", [e.id], /only by the edit checks/);
    const q = await h.one(ins, [e.id, v.id]);
    assert.deepEqual([q.status, q.opened_by, q.site_id], ['open', 'demo|cra', S101]);
    await h.as(PI(), 'answer'); await c.query("update core.edc_query set status = 'answered', answer = 'Sitting' where id = $1", [q.id]);
    await h.as(CRA(), 'Position must be documented in the source too');
    const re = await h.one("update core.edc_query set status = 'open' where id = $1 returning *", [q.id]);
    assert.deepEqual([re.status, re.answer], ['open', null]);
    await h.as(CRA(), 'cancel');
    const cx = await h.one("update core.edc_query set status = 'cancelled', close_reason = 'Raised on the wrong form' where id = $1 returning status", [q.id]);
    assert.equal(cx.status, 'cancelled');
  });
});

// ===================================================================================================================
// EDC-11 · no arm data in the blinded eCRF
// ===================================================================================================================
const EDC_RELATIONS = ['codelist', 'codelist_term', 'visit_definition', 'crf_form', 'crf_version', 'crf_item', 'crf_edit_check', 'crf_visit',
  'subject_visit', 'crf_entry', 'item_value', 'edc_query', 'v_visit_data_collection'];

test('[EDC-11][IAM-04] no EDC table or view has an arm column or a reference to the arm; no EDC function reads the allocation', async () => {
  const cols = (await c.query(`select table_name, column_name from information_schema.columns where table_schema = 'core'
    and table_name = any($1) and column_name ilike '%arm%'`, [EDC_RELATIONS])).rows;
  assert.deepEqual(cols, []);
  const fks = (await c.query(`select conrelid::regclass::text t from pg_constraint where contype = 'f' and confrelid = 'core.arm'::regclass
    and conrelid::regclass::text = any($1)`, [EDC_RELATIONS.map(t => `core.${t}`)])).rows;
  assert.deepEqual(fks, []);
  const fns = (await c.query(`select proname from pg_proc where pronamespace = 'core'::regnamespace
    and (proname like 'edc_%' or proname like 'crf_%' or proname like 'item_value_%' or proname like 'subject_visit_%' or proname like 'codelist%'
         or proname = 'visit_definition_integrity') and (prosrc ilike '%arm_id%' or prosrc ilike '%subject_allocation%')`)).rows;
  assert.deepEqual(fns, []);
  assert.equal((await c.query("select count(*)::int n from pg_proc where pronamespace = 'core'::regnamespace and proname like 'edc_%'")).rows[0].n >= 8, true);
});

test('[EDC-11][IAM-07] blinded users and agents read EDC data and visit.completed events without any arm', async () => {
  const visits = (await c.query("select id from core.subject_visit where status = 'completed'")).rows.map(r => r.id);
  assert.ok(visits.length >= 3);
  const ev = (await c.query("select arm_id, data from core.event_outbox where type = 'visit.completed'")).rows;
  assert.equal(ev.length, visits.length);
  for (const e of ev) {
    assert.equal(e.arm_id, null);
    assert.ok(!Object.keys(e.data).some(k => /arm/i.test(k)), JSON.stringify(e.data));
  }
  await scenario(async h => {
    const armIds = (await c.query('select id from core.arm')).rows.map(r => r.id);
    for (const claims of [person('demo|ctm', ['ctm']), PI(), person('agent:x', ['data_manager'], { actor_type: 'agent', blinding: 'unblinded' })]) {
      await h.as(claims);
      for (const t of EDC_RELATIONS) {
        const rows = (await c.query(`select * from core.${t}`)).rows;
        const text = JSON.stringify(rows);
        for (const a of armIds) assert.ok(!text.includes(a), `${t} exposes an arm id to ${claims.sub}`);
      }
      await c.query('savepoint s');
      await rejects(c.query('select arm_id from core.subject limit 1'), /permission denied/);
      await c.query('rollback to savepoint s');
    }
  });
});

// ===================================================================================================================
// EDC-12 · visit.completed and the data collection metric
// ===================================================================================================================
test('[EDC-12] completing a visit emits visit.completed with the time from visit date to data available', async () => {
  await scenario(async h => {
    const { sv, e } = await visitWithVs(h, SUBJ[1], 'BL', '2026-10-14');
    for (const [oid, val] of [['I.VS.SYSBP', '118'], ['I.VS.DIABP', '76']]) await put(e.id, oid, val);
    await h.as(PI(), 'complete');
    await c.query("update core.crf_entry set status = 'complete' where id = $1", [e.id]);
    const done = await h.one("update core.subject_visit set status = 'completed', completed_at = '2000-01-01' where id = $1 returning *", [sv.id]);
    assert.ok(done.completed_at > new Date('2026-10-14'), 'server time');
    assert.equal(done.completed_by, 'demo|pi101');
    await h.as(null);
    const ev = await h.one("select * from core.event_outbox where type = 'visit.completed' and subject = $1", [`subject_visit/${sv.id}`]);
    assert.equal(ev.data.visit_code, 'BL');
    assert.equal(ev.data.site_id, S101);
    assert.equal(ev.arm_id, null);
    const expected = (Date.parse(done.completed_at) - Date.parse('2026-10-14T00:00:00Z')) / 864e5;
    assert.ok(Math.abs(Number(ev.data.days_to_data) - expected) < 0.01);
    const m = await h.one('select days_to_data from core.v_visit_data_collection where subject_visit_id = $1', [sv.id]);
    assert.equal(Number(m.days_to_data), Number(ev.data.days_to_data));
    await h.as(PI(), 'reopen for a correction');
    const re = await h.one("update core.subject_visit set status = 'in_progress' where id = $1 returning completed_at", [sv.id]);
    assert.equal(re.completed_at, null);
  });
});

test('[EDC-12][M11-01] the TA3 data collection metric is defined from visit.completed', async () => {
  const d = (await c.query("select * from core.metric_definition where code = 'TA3-DATA-COLLECT'")).rows[0];
  assert.deepEqual(d.source_events, ['visit.completed']);
  assert.equal(Number(d.final_target), 2);
});
