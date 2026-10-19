// Native EDC through the Platform API (routes/edc.ts on migration 0027): library, data entry, edit checks, queries,
// visit completion and the data collection metric, with the synthetic demo users of the seed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApi, platformId, SIGN, type Api } from './_helpers.ts';

let api: Api; let plat: string; let subject: string; let vs: string; let w12: string; let armIds: string[];
before(async () => {
  api = await startApi(); plat = await platformId(api.admin);
  const site101 = (await api.admin.query("select id from core.site where platform_id = $1 and site_number = '101'", [plat])).rows[0].id;
  subject = (await api.admin.query(`select id from core.subject where site_id = $1 and status = 'on_treatment' order by subject_code offset 3 limit 1`, [site101])).rows[0].id;
  vs = (await api.admin.query("select id from core.crf_form where oid = 'F.VS'")).rows[0].id;
  w12 = (await api.admin.query("select id from core.visit_definition where code = 'W12'")).rows[0].id;
  armIds = (await api.admin.query('select id from core.arm')).rows.map(r => r.id);
});
after(async () => api.close());

const noArm = (body: unknown, what: string) => {
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /"arm_id"|"arm_code"/, `${what} carries an arm field`);
  for (const a of armIds) assert.ok(!text.includes(a), `${what} carries an arm id`);
};

test('[EDC-01] the CRF library lists forms with versions; a version shows CDASH items, units, codelists, checks, visits and its signature', async () => {
  const lib = await api.call('GET', `/v1/platforms/${plat}/crf-forms`, { as: 'demo|dm' });
  assert.equal(lib.status, 200);
  const f = lib.body.items.find((x: any) => x.oid === 'F.VS');
  assert.deepEqual(f.versions.map((v: any) => [v.version_no, v.status]), [[2, 'draft'], [1, 'approved']]);
  assert.deepEqual(f.versions[1].visits, ['SCR', 'BL', 'W4', 'W12']);
  const v1 = await api.call('GET', `/v1/crf-versions/${f.versions[1].id}`, { as: 'demo|pi101' });
  assert.equal(v1.status, 200);
  const sys = v1.body.items.find((i: any) => i.oid === 'I.VS.SYSBP');
  assert.deepEqual([sys.cdash_variable, sys.data_type, sys.unit, sys.required], ['SYSBP', 'integer', 'mmHg', true]);
  assert.deepEqual(v1.body.items.find((i: any) => i.oid === 'I.VS.VSPOS').terms.map((t: any) => t.value), ['SITTING', 'SUPINE', 'STANDING']);
  assert.ok(v1.body.checks.some((k: any) => k.code === 'EC.VS.PULSE.LIMIT' && k.severity === 'hard'));
  assert.equal(v1.body.approved_signature.meaning, 'approval');
  assert.equal(v1.body.approved_signature.signer_name, 'Dana Whitfield');
  const visits = await api.call('GET', `/v1/platforms/${plat}/visit-definitions`, { as: 'demo|pi101' });
  assert.deepEqual(visits.body.items.map((v: any) => v.code), ['SCR', 'BL', 'W4', 'W12']);
  const lists = await api.call('GET', `/v1/platforms/${plat}/codelists`, { as: 'demo|pi101' });
  assert.deepEqual(lists.body.items.map((l: any) => l.code), ['NY', 'UNIT', 'VSPOS']);
});

test('[EDC-01][CMP-02][IAM-05] a draft is approved with a signature by a non-author; the previous version is superseded; approved versions cannot be edited', async () => {
  const f = (await api.call('GET', `/v1/platforms/${plat}/crf-forms`, { as: 'demo|dm' })).body.items.find((x: any) => x.oid === 'F.VS');
  const v2 = f.versions[0].id;
  assert.equal((await api.call('POST', `/v1/crf-versions/${v2}/approve`, { as: 'demo|dm', reason: 'approve', body: SIGN })).status, 403, 'author of v2 (IAM-05)');
  assert.equal((await api.call('POST', `/v1/crf-versions/${v2}/approve`, { as: 'demo|pi101', reason: 'approve', body: SIGN })).status, 403, 'site role');
  const ok = await api.call('POST', `/v1/crf-versions/${v2}/approve`, { as: 'demo|admin', reason: 'Vital signs v2 adds weight', body: SIGN });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'approved');
  assert.equal(ok.body.approved_signature.signer_name, 'Dana Whitfield');
  const after = (await api.call('GET', `/v1/platforms/${plat}/crf-forms`, { as: 'demo|dm' })).body.items.find((x: any) => x.oid === 'F.VS');
  assert.deepEqual(after.versions.map((v: any) => v.status), ['approved', 'superseded']);
  const edit = await api.call('POST', `/v1/crf-versions/${v2}/items`, { as: 'demo|dm', body: { oid: 'I.VS.TEMP', cdash_variable: 'TEMP', label: 'Temperature', data_type: 'decimal' } });
  assert.equal(edit.status, 409);
  // a new draft copies the approved content and can be extended
  const v3 = await api.call('POST', `/v1/crf-forms/${vs}/versions`, { as: 'demo|dm', body: {} });
  assert.equal(v3.status, 201, JSON.stringify(v3.body));
  assert.equal(v3.body.version_no, 3);
  assert.equal(v3.body.items.length, 5);
  assert.equal((await api.call('POST', `/v1/crf-forms/${vs}/versions`, { as: 'demo|dm', body: {} })).status, 409, 'one draft at a time');
  const chk = await api.call('POST', `/v1/crf-versions/${v3.body.id}/edit-checks`, { as: 'demo|dm', body: { code: 'EC.VS.WEIGHT.RANGE', kind: 'range',
    item_oid: 'I.VS.WEIGHT', min_value: 30, max_value: 250, message: 'Weight outside 30-250 kg' } });
  assert.equal(chk.status, 201, JSON.stringify(chk.body));
  const bad = await api.call('POST', `/v1/crf-versions/${v3.body.id}/edit-checks`, { as: 'demo|dm', body: { code: 'EC.VS.X', kind: 'range', item_oid: 'I.VS.NOPE',
    min_value: 1, message: 'x' } });
  assert.equal(bad.status, 422);
  assert.equal((await api.call('POST', `/v1/platforms/${plat}/crf-forms`, { as: 'demo|pi101', body: { oid: 'F.AE', name: 'Adverse events' } })).status, 403);
});

let entry: string; let visit: string;
test('[EDC-03][EDC-04] the site starts a visit and a form; a soft check failure opens a query on save; a hard check refuses the value', async () => {
  const subjects = await api.call('GET', `/v1/platforms/${plat}/edc/subjects`, { as: 'demo|pi101' });
  assert.equal(subjects.status, 200);
  assert.ok(subjects.body.items.every((s: any) => s.site_number === '101'));
  noArm(subjects.body, 'subject list');
  const future = await api.call('POST', `/v1/edc/subjects/${subject}/visits`, { as: 'demo|pi101', body: { visit_definition_id: w12, visit_date: '2099-01-01' } });
  assert.equal(future.status, 422);
  const v = await api.call('POST', `/v1/edc/subjects/${subject}/visits`, { as: 'demo|pi101', body: { visit_definition_id: w12, visit_date: '2026-10-16' } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  visit = v.body.id;
  assert.equal(v.body.visit_date, '2026-10-16');
  assert.equal(v.body.forms.find((f: any) => f.oid === 'F.VS').entry, null);
  assert.equal((await api.call('POST', `/v1/edc/subjects/${subject}/visits`, { as: 'demo|dm', body: { visit_definition_id: w12, visit_date: '2026-10-16' } })).status, 403);
  const e = await api.call('POST', `/v1/subject-visits/${visit}/entries`, { as: 'demo|pi101', body: { crf_form_id: vs } });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  const form = e.body.forms.find((f: any) => f.oid === 'F.VS');
  entry = form.entry.id;
  assert.equal(form.version.version_no, 2, 'bound to the version approved at the time of entry (v2, approved by the previous test)');
  assert.ok(form.version.items.some((i: any) => i.oid === 'I.VS.WEIGHT'));
  const hard = await api.call('PUT', `/v1/crf-entries/${entry}/values`, { as: 'demo|pi101', body: { values: [{ item_oid: 'I.VS.PULSE', value: 400 }] } });
  assert.equal(hard.status, 422);
  assert.match(hard.body.error.message, /hard edit check EC.VS.PULSE.LIMIT/);
  const saved = await api.call('PUT', `/v1/crf-entries/${entry}/values`, { as: 'demo|pi101', body: { values: [
    { item_oid: 'I.VS.SYSBP', value: 270 }, { item_oid: 'I.VS.DIABP', value: '80' }, { item_oid: 'I.VS.PULSE', value: null, missing_reason: 'ND' },
    { item_oid: 'I.VS.VSPOS', value: 'SITTING' }] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.queries_opened, 1);
  const f = saved.body.visit.forms.find((x: any) => x.oid === 'F.VS');
  const sys = f.values.find((x: any) => x.item_oid === 'I.VS.SYSBP');
  assert.equal(sys.entered_by, 'demo|pi101');
  assert.equal(f.values.find((x: any) => x.item_oid === 'I.VS.PULSE').missing_reason, 'ND');
  assert.deepEqual(f.queries.map((q: any) => [q.check_code, q.status, q.item_oid]), [['EC.VS.SYSBP.RANGE', 'open', 'I.VS.SYSBP']]);
  noArm(saved.body, 'visit');
  assert.equal((await api.call('PUT', `/v1/crf-entries/${entry}/values`, { as: 'demo|dm', body: { values: [{ item_oid: 'I.VS.SYSBP', value: 120 }] } })).status, 403);
  assert.equal((await api.call('GET', `/v1/subject-visits/${visit}`, { as: 'demo|pi102' })).status, 404, 'another site');
});

test('[EDC-05] the site answers, cannot close; the data manager closes; the queries list filters by status', async () => {
  const q = (await api.call('GET', `/v1/platforms/${plat}/edc-queries?status=open`, { as: 'demo|dm' })).body.items.find((x: any) => x.subject_visit_id === visit);
  assert.ok(q, 'listed');
  assert.equal(q.check_code, 'EC.VS.SYSBP.RANGE');
  noArm(q, 'query list');
  assert.equal((await api.call('POST', `/v1/edc-queries/${q.id}/close`, { as: 'demo|pi101', body: { reason: 'x' } })).status, 403);
  const a = await api.call('POST', `/v1/edc-queries/${q.id}/answer`, { as: 'demo|pi101', body: { answer: 'Confirmed: hypertensive crisis documented in source' } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([a.body.status, a.body.answered_by], ['answered', 'demo|pi101']);
  const re = await api.call('POST', `/v1/edc-queries/${q.id}/requery`, { as: 'demo|cra', body: { reason: 'Please attach the source page reference' } });
  assert.equal(re.body.status, 'open');
  await api.call('POST', `/v1/edc-queries/${q.id}/answer`, { as: 'demo|pi101', body: { answer: 'Source page 12' } });
  const c = await api.call('POST', `/v1/edc-queries/${q.id}/close`, { as: 'demo|dm', body: { reason: 'Answer accepted' } });
  assert.deepEqual([c.body.status, c.body.closed_by, c.body.answer], ['closed', 'demo|dm', 'Source page 12']);
  const closed = await api.call('GET', `/v1/platforms/${plat}/edc-queries?status=closed`, { as: 'demo|dm' });
  assert.ok(closed.body.items.some((x: any) => x.id === q.id));
  const manual = await api.call('POST', `/v1/crf-entries/${entry}/queries`, { as: 'demo|cra', body: { item_oid: 'I.VS.VSPOS', question: 'Position per protocol is supine' } });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  assert.equal((await api.call('POST', `/v1/crf-entries/${entry}/queries`, { as: 'demo|pi101', body: { question: 'x' } })).status, 403);
  const cx = await api.call('POST', `/v1/edc-queries/${manual.body.id}/cancel`, { as: 'demo|cra', body: { reason: 'Protocol allows sitting' } });
  assert.equal(cx.body.status, 'cancelled');
});

test('[EDC-03][EDC-04][DM-03] a correction needs a reason; it closes the edit-check query it resolves; prior values are kept', async () => {
  const noReason = await api.call('PUT', `/v1/crf-entries/${entry}/values`, { as: 'demo|pi101', body: { values: [{ item_oid: 'I.VS.SYSBP', value: 170 }] } });
  assert.equal(noReason.status, 422);
  assert.match(noReason.body.error.message, /change reason required/);
  // a new out-of-range value, then its correction
  const again = await api.call('PUT', `/v1/crf-entries/${entry}/values`, { as: 'demo|pi101', reason: 'Re-measured', body: { values: [{ item_oid: 'I.VS.SYSBP', value: 265 }] } });
  assert.equal(again.body.queries_opened, 1);
  const fix = await api.call('PUT', `/v1/crf-entries/${entry}/values`, { as: 'demo|pi101', reason: 'Transcription error: 165 in source',
    body: { values: [{ item_oid: 'I.VS.SYSBP', value: 165 }] } });
  assert.equal(fix.status, 200);
  const f = fix.body.visit.forms.find((x: any) => x.oid === 'F.VS');
  const last = f.queries.filter((q: any) => q.check_code === 'EC.VS.SYSBP.RANGE').at(-1);
  assert.equal(last.status, 'closed');
  assert.match(last.close_reason, /Resolved by data change/);
  const sys = f.values.find((x: any) => x.item_oid === 'I.VS.SYSBP');
  const hist = await api.call('GET', `/v1/item-values/${sys.id}/history`, { as: 'demo|pi101' });
  assert.deepEqual(hist.body.items.map((h: any) => h.value), ['270', '265', '165']);
  assert.deepEqual(hist.body.items.map((h: any) => h.reason), [null, 'Re-measured', 'Transcription error: 165 in source']);
  assert.equal((await api.call('GET', `/v1/item-values/${sys.id}/history`, { as: 'demo|pi102' })).status, 403);
});

test('[EDC-12][M11-02] completing the forms and the visit emits visit.completed and feeds the TA3 data collection metric', async () => {
  const early = await api.call('POST', `/v1/subject-visits/${visit}/complete`, { as: 'demo|pi101' });
  assert.equal(early.status, 422);
  assert.match(early.body.error.message, /forms not complete: F.VS/);
  assert.equal((await api.call('POST', `/v1/crf-entries/${entry}/complete`, { as: 'demo|pi101' })).status, 200);
  const done = await api.call('POST', `/v1/subject-visits/${visit}/complete`, { as: 'demo|pi101' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'completed');
  const ev = (await api.admin.query("select arm_id, data from core.event_outbox where type = 'visit.completed' and subject = $1", [`subject_visit/${visit}`])).rows;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].arm_id, null);
  const m = await api.call('GET', `/v1/platforms/${plat}/metrics`, { as: 'demo|ops' });
  const dc = m.body.items.find((x: any) => x.code === 'TA3-DATA-COLLECT');
  assert.equal(typeof dc.headline.value, 'number');
  assert.equal(dc.per_arm, false);
  const drill = await api.call('GET', `/v1/platforms/${plat}/metrics/TA3-DATA-COLLECT`, { as: 'demo|ops' });
  const v = drill.body.values[0];
  assert.ok(v.sources.some((s: any) => s.id === visit));
  assert.ok(v.events.some((e: any) => e.label.startsWith('visit.completed')));
  // a sponsor does not read subject-level EDC data, so it has no value for this metric
  const sp = await api.call('GET', `/v1/platforms/${plat}/metrics`, { as: 'demo|arden' });
  assert.equal(sp.body.items.find((x: any) => x.code === 'TA3-DATA-COLLECT').headline.value, null);
});

test('[EDC-11] EDC responses to blinded people never carry the arm; the routes never read the allocation', async () => {
  for (const [as, path] of [['demo|ctm', `/v1/platforms/${plat}/edc/subjects`], ['demo|ctm', `/v1/edc/subjects/${subject}`],
    ['demo|cra', `/v1/subject-visits/${visit}`], ['demo|dm', `/v1/platforms/${plat}/edc-queries`]] as const) {
    const r = await api.call('GET', path, { as });
    assert.equal(r.status, 200, path);
    noArm(r.body, path);
  }
  const src = readFileSync(new URL('../src/routes/edc.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /arm_id|subject_allocation|from core\.subject\b(?!_)/, 'routes read subjects only through core.subject_blinded without the allocation');
});
