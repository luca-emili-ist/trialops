// Native EDC demo data (EDC-01, EDC-03, EDC-04, EDC-05, EDC-12): a small synthetic CRF library (vital signs and
// eligibility) linked to the visits of the Master Protocol, versioned codelists (rule 13), and a few visits, values and
// queries at site 101. Shared by seed-demo.mjs and scripts/backfill-demo-edc.mjs, so the remote demo gets exactly the
// rows of the local seed. Synthetic only (DM-05): no real patient data, the codelists are a demo subset (NCI codes only
// where they are the well-known No/Yes codes; the licensed CDISC CT package replaces them in a real trial).
// Runs inside the caller's transaction, as the database owner; the author of every row is set with trialops.actor
// (the demo data manager authors the library, the demo PI of site 101 enters the data). Time stamps are the server's.
import { createHash } from 'node:crypto';

export async function seedEdc(c) {
  const one = async (sql, args = []) => (await c.query(sql, args)).rows[0];
  const prev = await one("select coalesce(current_setting('trialops.actor', true), '') actor, coalesce(current_setting('trialops.change_reason', true), '') reason");
  const as = async (actor, reason) => {
    await c.query("select set_config('trialops.actor', $1, true)", [actor]);
    await c.query("select set_config('trialops.change_reason', $1, true)", [reason]);
  };
  const plat = (await one("select id from core.platform where code = 'PLAT-001'")).id;
  const mp = (await one("select id from core.master_protocol_version where platform_id = $1 and status = 'approved' order by created_at desc limit 1", [plat])).id;
  const site101 = (await one("select id from core.site where platform_id = $1 and site_number = '101'", [plat])).id;

  // ---- library, authored by the demo data manager
  await as('demo|dm', 'synthetic demo seed: EDC library (EDC-01)');
  const codelist = async (code, name, dictionary, version, terms) => {
    const id = (await one(`insert into core.codelist(platform_id, code, name, dictionary, dictionary_version) values ($1,$2,$3,$4,$5) returning id`,
      [plat, code, name, dictionary, version])).id;
    const out = {};
    for (const [i, [value, decode, nci]] of terms.entries())
      out[value] = (await one(`insert into core.codelist_term(codelist_id, submission_value, decode, nci_code, ordinal) values ($1,$2,$3,$4,$5) returning id`,
        [id, value, decode, nci ?? null, i + 1])).id;
    await c.query("update core.codelist set status = 'approved' where id = $1", [id]);
    return { id, terms: out };
  };
  const NY = await codelist('NY', 'No Yes Response', 'CDISC-CT', '2026-09-26-demo', [['N', 'No', 'C49487'], ['Y', 'Yes', 'C49488']]);
  const UNIT = await codelist('UNIT', 'Units (demo subset)', 'CDISC-CT', '2026-09-26-demo',
    [['mmHg', 'Millimeter of Mercury'], ['beats/min', 'Beats per Minute'], ['kg', 'Kilogram']]);
  const VSPOS = await codelist('VSPOS', 'Vital Signs Position of Subject (demo subset)', 'CDISC-CT', '2026-09-26-demo',
    [['SITTING', 'Sitting'], ['SUPINE', 'Supine'], ['STANDING', 'Standing']]);

  const visit = {};
  for (const [i, [code, name, day, before, after]] of [['SCR', 'Screening', -14, 14, 0], ['BL', 'Baseline', 1, 0, 0],
    ['W4', 'Week 4', 29, 3, 3], ['W12', 'Week 12', 85, 7, 7]].entries())
    visit[code] = (await one(`insert into core.visit_definition(platform_id, master_protocol_version_id, code, name, ordinal, planned_day,
      window_before_days, window_after_days, usdm_encounter_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [plat, mp, code, name, i + 1, day, before, after, `ENC_${code}`])).id;

  const form = async (oid, name, domain) => (await one('insert into core.crf_form(platform_id, oid, name, cdash_domain) values ($1,$2,$3,$4) returning id',
    [plat, oid, name, domain])).id;
  const version = async formId => (await one('insert into core.crf_version(form_id) values ($1) returning id, version_no', [formId]));
  const item = (v, oid, variable, label, type, extra = {}) => c.query(`insert into core.crf_item(crf_version_id, oid, cdash_variable, label, data_type,
      codelist_id, unit_term_id, required, ordinal) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [v, oid, variable, label, type, extra.codelist ?? null, extra.unit ?? null, extra.required ?? false, extra.ordinal ?? 0]);
  const check = (v, code, kind, itemOid, extra, severity, message) => c.query(`insert into core.crf_edit_check(crf_version_id, code, kind, item_oid,
      operator, other_item_oid, min_value, max_value, severity, message) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [v, code, kind, itemOid, extra.op ?? null, extra.other ?? null, extra.min ?? null, extra.max ?? null, severity, message]);
  const schedule = (v, codes) => Promise.all(codes.map(k => c.query('insert into core.crf_visit(crf_version_id, visit_definition_id) values ($1,$2)', [v, visit[k]])));

  const vsItems = async v => {
    await item(v, 'I.VS.SYSBP', 'SYSBP', 'Systolic blood pressure', 'integer', { unit: UNIT.terms.mmHg, required: true, ordinal: 1 });
    await item(v, 'I.VS.DIABP', 'DIABP', 'Diastolic blood pressure', 'integer', { unit: UNIT.terms.mmHg, required: true, ordinal: 2 });
    await item(v, 'I.VS.PULSE', 'PULSE', 'Pulse rate', 'integer', { unit: UNIT.terms['beats/min'], ordinal: 3 });
    await item(v, 'I.VS.VSPOS', 'VSPOS', 'Position of subject', 'coded', { codelist: VSPOS.id, ordinal: 4 });
    await check(v, 'EC.VS.SYSBP.REQ', 'required', 'I.VS.SYSBP', {}, 'soft', 'Systolic blood pressure is missing: enter it or record ND/NA/UNK.');
    await check(v, 'EC.VS.SYSBP.RANGE', 'range', 'I.VS.SYSBP', { min: 60, max: 250 }, 'soft', 'Systolic blood pressure outside 60-250 mmHg: please confirm against source.');
    await check(v, 'EC.VS.DIABP.RANGE', 'range', 'I.VS.DIABP', { min: 30, max: 150 }, 'soft', 'Diastolic blood pressure outside 30-150 mmHg: please confirm against source.');
    await check(v, 'EC.VS.BP.ORDER', 'compare', 'I.VS.DIABP', { op: '<', other: 'I.VS.SYSBP' }, 'soft', 'Diastolic blood pressure is not lower than systolic: please check.');
    await check(v, 'EC.VS.PULSE.LIMIT', 'range', 'I.VS.PULSE', { min: 20, max: 250 }, 'hard', 'Pulse rate outside the physiological limits 20-250 beats/min.');
    await schedule(v, ['SCR', 'BL', 'W4', 'W12']);
  };
  const fVS = await form('F.VS', 'Vital signs', 'VS');
  const vs1 = await version(fVS);
  await vsItems(vs1.id);
  const fIE = await form('F.IE', 'Eligibility', 'IE');
  const ie1 = await version(fIE);
  await item(ie1.id, 'I.IE.IEYN', 'IEYN', 'All eligibility criteria met', 'coded', { codelist: NY.id, required: true, ordinal: 1 });
  await check(ie1.id, 'EC.IE.IEYN.REQ', 'required', 'I.IE.IEYN', {}, 'hard', 'Eligibility must be answered before the form is complete.');
  await schedule(ie1.id, ['SCR']);

  // approval: signature of the demo platform admin (not an author: separation of duties, IAM-05)
  for (const v of [vs1.id, ie1.id]) {
    const content = (await one(`select jsonb_build_object('version', v.version_no, 'items', (select jsonb_agg(i.oid order by i.ordinal) from core.crf_item i where i.crf_version_id = v.id),
      'checks', (select jsonb_agg(k.code order by k.code) from core.crf_edit_check k where k.crf_version_id = v.id)) c from core.crf_version v where v.id = $1`, [v])).c;
    const sig = (await one(`insert into core.signature(signer_sub, signer_name, meaning, target_table, target_id, target_hash, auth_method)
      values ('demo|admin', 'Dana Whitfield', 'approval', 'crf_version', $1, $2, 'reauth_mfa') returning id`,
      [v, createHash('sha256').update(JSON.stringify(content)).digest('hex')])).id;
    await as('demo|admin', 'synthetic demo seed: CRF version approved (EDC-01)');
    await c.query("update core.crf_version set status = 'approved', approved_signature_id = $2 where id = $1", [v, sig]);
    await as('demo|dm', 'synthetic demo seed: EDC library (EDC-01)');
  }
  // a draft version 2 of the vital signs CRF (adds weight), to show versioning in the library
  const vs2 = await version(fVS);
  await vsItems(vs2.id);
  await item(vs2.id, 'I.VS.WEIGHT', 'WEIGHT', 'Weight', 'decimal', { unit: UNIT.terms.kg, ordinal: 5 });

  // ---- data of site 101, entered by the demo PI (server time); queries opened by the edit checks
  const subjects = (await c.query(`select id from core.subject where site_id = $1 and status = 'on_treatment' order by subject_code limit 3`, [site101])).rows.map(r => r.id);
  if (subjects.length < 3) throw new Error('seed-edc: site 101 needs three subjects on treatment');
  await as('demo|pi101', 'synthetic demo seed: site data entry (EDC-03)');
  const startVisit = async (subject, code, date) => (await one(`insert into core.subject_visit(subject_id, visit_definition_id, visit_date)
    values ($1,$2,$3) returning id`, [subject, visit[code], date])).id;
  const startForm = async (sv, formId) => (await one('insert into core.crf_entry(subject_visit_id, crf_form_id) values ($1,$2) returning id', [sv, formId])).id;
  const put = (entry, values) => Promise.all(Object.entries(values).map(([oid, v]) => c.query(
    `insert into core.item_value(crf_entry_id, crf_item_id, item_oid, value) values ($1, (select i.id from core.crf_item i join core.crf_entry e
       on e.crf_version_id = i.crf_version_id where e.id = $1 and i.oid = $2), $2, $3)`, [entry, oid, String(v)])));
  const complete = async (table, id, reason) => {
    await c.query("select set_config('trialops.change_reason', $1, true)", [reason]);
    await c.query(`update core.${table} set status = $2 where id = $1`, [id, table === 'crf_entry' ? 'complete' : 'completed']);
  };
  const vsForm = async (sv, values) => {
    const e = await startForm(sv, fVS);
    for (const [oid, v] of Object.entries(values)) await put(e, { [oid]: v });    // one at a time: deterministic order of checks
    return e;
  };

  // subject 1: screening and baseline complete; week 4 in progress with an out-of-range systolic value -> open query
  const s1scr = await startVisit(subjects[0], 'SCR', '2026-10-01');
  const ie = await startForm(s1scr, fIE); await put(ie, { 'I.IE.IEYN': 'Y' }); await complete('crf_entry', ie, 'Form completed');
  await complete('crf_entry', await vsForm(s1scr, { 'I.VS.SYSBP': 122, 'I.VS.DIABP': 78, 'I.VS.PULSE': 72, 'I.VS.VSPOS': 'SITTING' }), 'Form completed');
  await complete('subject_visit', s1scr, 'Visit completed');
  const s1bl = await startVisit(subjects[0], 'BL', '2026-10-08');
  await complete('crf_entry', await vsForm(s1bl, { 'I.VS.SYSBP': 128, 'I.VS.DIABP': 84, 'I.VS.PULSE': 70, 'I.VS.VSPOS': 'SITTING' }), 'Form completed');
  await complete('subject_visit', s1bl, 'Visit completed');
  const s1w4 = await startVisit(subjects[0], 'W4', '2026-10-15');
  await vsForm(s1w4, { 'I.VS.SYSBP': 262, 'I.VS.DIABP': 90, 'I.VS.PULSE': 76 });

  // subject 2: baseline with diastolic not lower than systolic -> query, answered by the site
  const s2scr = await startVisit(subjects[1], 'SCR', '2026-10-02');
  const ie2 = await startForm(s2scr, fIE); await put(ie2, { 'I.IE.IEYN': 'Y' }); await complete('crf_entry', ie2, 'Form completed');
  const e2 = await vsForm(s2scr, { 'I.VS.SYSBP': 110, 'I.VS.DIABP': 112, 'I.VS.PULSE': 64, 'I.VS.VSPOS': 'SUPINE' });
  await complete('crf_entry', e2, 'Form completed');
  await c.query("select set_config('trialops.change_reason', 'Query answered by the site', true)");
  await c.query(`update core.edc_query set status = 'answered', answer = 'Values confirmed against the source document (synthetic).'
    where crf_entry_id = $1 and status = 'open'`, [e2]);

  // subject 3: screening with a diastolic typo, corrected with a reason -> the query is closed by the data change
  const s3scr = await startVisit(subjects[2], 'SCR', '2026-10-05');
  const ie3 = await startForm(s3scr, fIE); await put(ie3, { 'I.IE.IEYN': 'Y' }); await complete('crf_entry', ie3, 'Form completed');
  const e3 = await vsForm(s3scr, { 'I.VS.SYSBP': 131, 'I.VS.DIABP': 185, 'I.VS.PULSE': 81, 'I.VS.VSPOS': 'SITTING' });
  await c.query("select set_config('trialops.change_reason', 'Transcription error: 85 mmHg in the source document', true)");
  await c.query("update core.item_value set value = '85' where crf_entry_id = $1 and item_oid = 'I.VS.DIABP'", [e3]);
  await complete('crf_entry', e3, 'Form completed');
  await complete('subject_visit', s3scr, 'Visit completed');

  await c.query("select set_config('trialops.actor', $1, true), set_config('trialops.change_reason', $2, true)", [prev.actor, prev.reason]);
  return { platform: plat, forms: { VS: fVS, IE: fIE }, visits: visit };
}
