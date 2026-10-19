// Native EDC (module M06b, migration 0027): CRF library (EDC-01), site data entry (EDC-03), declarative edit checks
// (EDC-04), query workflow (EDC-05), visit completion (EDC-12). The database is the enforcement point: roles, perimeter,
// state machines, server time and the edit checks live in 0027; these routes only shape requests and responses.
// Blinding (EDC-11, rule 5): no query here reads the allocation; subjects come from core.subject_blinded with an explicit
// column list that leaves the allocation out, and no response carries an arm.
import { route, uuid, type RouteDef } from '../route.ts';
import type { Db, Row } from '../db.ts';
import { HttpError } from '../errors.ts';
import { requireRole, type Role } from '../lib/roles.ts';
import { sign, signatureManifests } from '../lib/sign.ts';

const LIBRARY_ROLES: Role[] = ['data_manager', 'platform_admin'];
const SITE_ROLES: Role[] = ['site_pi', 'study_coordinator'];
const REVIEW_ROLES: Role[] = ['data_manager', 'cra'];
const MISSING = ['ND', 'NA', 'UNK'] as const;

/** Change reason of a workflow step whose meaning is the step itself (the caller may give a more precise one). */
const withReason = (db: Db, given: string | undefined, fallback: string) =>
  db.query("select set_config('trialops.change_reason', $1, true)", [given ?? fallback]);

const one = async (db: Db, sql: string, args: unknown[]): Promise<Row | undefined> => (await db.query(sql, args)).rows[0];

// ===== library =====
async function versionDetail(db: Db, id: string): Promise<Row | undefined> {
  const v = await one(db, `select v.id, v.platform_id, v.form_id, f.oid form_oid, f.name form_name, f.cdash_domain, v.version_no, v.status,
      v.approved_signature_id, v.approved_at, v.created_by, v.created_at, v.row_version
    from core.crf_version v join core.crf_form f on f.id = v.form_id where v.id = $1`, [id]);
  if (!v) return undefined;
  const items = (await db.query(`select i.id, i.oid, i.cdash_variable, i.label, i.data_type, i.required, i.ordinal, i.codelist_id,
      l.code codelist_code, l.dictionary, l.dictionary_version, u.submission_value unit,
      (select coalesce(jsonb_agg(jsonb_build_object('value', t.submission_value, 'decode', t.decode) order by t.ordinal), '[]')
         from core.codelist_term t where t.codelist_id = i.codelist_id) terms
    from core.crf_item i left join core.codelist l on l.id = i.codelist_id left join core.codelist_term u on u.id = i.unit_term_id
    where i.crf_version_id = $1 and i.status = 'active' order by i.ordinal, i.oid`, [id])).rows;
  const checks = (await db.query(`select id, code, kind, item_oid, operator, other_item_oid, min_value, max_value, severity, message
    from core.crf_edit_check where crf_version_id = $1 and status = 'active' order by code`, [id])).rows;
  const visits = (await db.query(`select d.id, d.code, d.name, d.planned_day from core.crf_visit l join core.visit_definition d on d.id = l.visit_definition_id
    where l.crf_version_id = $1 and l.status = 'active' order by d.ordinal`, [id])).rows;
  const sig = (await signatureManifests(db, [v.approved_signature_id])).get(v.approved_signature_id) ?? null;
  return { ...v, approved_signature: sig, items, checks, visits };
}

/** New draft version of a form, copying items, checks and visit links of a base version (default: the approved one). */
async function newDraft(db: Db, formId: string, copyFrom?: string): Promise<Row> {
  const base = copyFrom ?? (await one(db, "select id from core.crf_version where form_id = $1 and status = 'approved'", [formId]))?.id;
  const v = await one(db, 'insert into core.crf_version(form_id) values ($1) returning id', [formId]);
  if (base) {
    await db.query(`insert into core.crf_item(crf_version_id, oid, cdash_variable, label, data_type, codelist_id, unit_term_id, required, ordinal)
      select $2, oid, cdash_variable, label, data_type, codelist_id, unit_term_id, required, ordinal from core.crf_item where crf_version_id = $1 and status = 'active'`, [base, v!.id]);
    await db.query(`insert into core.crf_edit_check(crf_version_id, code, kind, item_oid, operator, other_item_oid, min_value, max_value, severity, message)
      select $2, code, kind, item_oid, operator, other_item_oid, min_value, max_value, severity, message from core.crf_edit_check
      where crf_version_id = $1 and status = 'active'`, [base, v!.id]);
    await db.query(`insert into core.crf_visit(crf_version_id, visit_definition_id) select $2, visit_definition_id from core.crf_visit
      where crf_version_id = $1 and status = 'active'`, [base, v!.id]);
  }
  return (await versionDetail(db, v!.id))!;
}

async function draft(db: Db, id: string): Promise<Row> {
  const v = await one(db, 'select id, status from core.crf_version where id = $1', [id]);
  if (!v) throw new HttpError(404, 'not_found', 'CRF version not found');
  if (v.status !== 'draft') throw new HttpError(409, 'not_draft', `CRF version is ${v.status}: approved versions are immutable, create a new version (EDC-01)`);
  return v;
}

// ===== data entry =====
const SUBJECT_COLS = 's.id, s.platform_id, s.site_id, s.subject_code, s.status';   // never the allocation (EDC-11)

async function visitDetail(db: Db, id: string): Promise<Row | undefined> {
  const v = await one(db, `select v.id, v.platform_id, v.site_id, v.subject_id, s.subject_code, st.site_number, v.visit_definition_id, d.code visit_code,
      d.name visit_name, v.visit_date::text visit_date, v.status, v.completed_at, v.completed_by, v.created_by, v.created_at, v.row_version
    from core.subject_visit v join core.visit_definition d on d.id = v.visit_definition_id join core.subject_blinded s on s.id = v.subject_id
    join core.site st on st.id = v.site_id where v.id = $1`, [id]);
  if (!v) return undefined;
  // forms scheduled at this visit (current approved version) plus forms already started with an older version
  const forms = (await db.query(`select f.id form_id, f.oid, f.name, coalesce(e.crf_version_id, cv.id) version_id, e.id entry_id, e.status entry_status,
      e.completed_at, e.completed_by
    from core.crf_form f
    left join core.crf_version cv on cv.form_id = f.id and cv.status = 'approved'
    left join core.crf_entry e on e.subject_visit_id = $1 and e.crf_form_id = f.id and e.status <> 'void'
    where f.platform_id = $2 and f.status = 'active' and (e.id is not null or exists (select 1 from core.crf_visit l
      where l.crf_version_id = cv.id and l.visit_definition_id = $3 and l.status = 'active'))
    order by f.oid`, [id, v.platform_id, v.visit_definition_id])).rows;
  const out = [];
  for (const f of forms) {
    const version = await versionDetail(db, f.version_id);
    const values = f.entry_id ? (await db.query(`select id, item_oid, value, missing_reason, entered_by, entered_at, source, source_app, row_version
      from core.item_value where crf_entry_id = $1 and status = 'active'`, [f.entry_id])).rows : [];
    const queries = f.entry_id ? (await db.query(`select q.id, q.item_value_id, i.oid item_oid, k.code check_code, q.origin, q.status, q.question, q.answer,
        q.answered_by, q.answered_at, q.close_reason, q.closed_by, q.closed_at, q.opened_by, q.opened_at
      from core.edc_query q left join core.crf_item i on i.id = q.crf_item_id left join core.crf_edit_check k on k.id = q.edit_check_id
      where q.crf_entry_id = $1 order by q.opened_at`, [f.entry_id])).rows : [];
    out.push({ form_id: f.form_id, oid: f.oid, name: f.name, entry: f.entry_id ? { id: f.entry_id, status: f.entry_status, completed_at: f.completed_at,
      completed_by: f.completed_by } : null, version: version ? { id: version.id, version_no: version.version_no, items: version.items, checks: version.checks } : null,
      values, queries });
  }
  return { ...v, forms: out };
}

interface ValueIn { item_oid: string; value?: string | number | null; missing_reason?: typeof MISSING[number] | null }

async function entryVisit(db: Db, entryId: string): Promise<string> {
  const e = await one(db, 'select subject_visit_id from core.crf_entry where id = $1', [entryId]);
  if (!e) throw new HttpError(404, 'not_found', 'form entry not found');
  return e.subject_visit_id;
}

async function queryRow(db: Db, id: string): Promise<Row> {
  const q = await one(db, `select q.*, i.oid item_oid, k.code check_code from core.edc_query q left join core.crf_item i on i.id = q.crf_item_id
    left join core.crf_edit_check k on k.id = q.edit_check_id where q.id = $1`, [id]);
  if (!q) throw new HttpError(404, 'not_found', 'query not found');
  return q;
}

async function moveQuery(db: Db, id: string, to: string, set: Record<string, string | null>, reason: string): Promise<Row> {
  await queryRow(db, id);
  await withReason(db, reason, reason);
  const cols = Object.keys(set);
  await db.query(`update core.edc_query set status = $2${cols.map((c, i) => `, ${c} = $${i + 3}`).join('')} where id = $1`, [id, to, ...cols.map(c => set[c])]);
  return queryRow(db, id);
}

const reasonBody = { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } } };

export const edcRoutes: RouteDef[] = [
  // ----- EDC-01 library
  route({ method: 'get', path: '/v1/platforms/:id/visit-definitions', summary: 'Visits of the platform schedule (from the Master Protocol)', tag: 'edc',
    reqs: ['EDC-01'],
    handler: async ({ db, params }) => ({ items: (await db.query(`select d.id, d.code, d.name, d.ordinal, d.planned_day, d.window_before_days, d.window_after_days,
        d.usdm_encounter_id, d.status, m.version_label protocol_version from core.visit_definition d join core.master_protocol_version m on m.id = d.master_protocol_version_id
      where d.platform_id = $1 and d.status <> 'void' order by d.ordinal, d.code`, [params.id])).rows }) }),

  route({ method: 'get', path: '/v1/platforms/:id/codelists', summary: 'Versioned codelists of the platform with their terms (rule 13)', tag: 'edc',
    reqs: ['EDC-01'],
    handler: async ({ db, params }) => ({ items: (await db.query(`select l.id, l.code, l.name, l.dictionary, l.dictionary_version, l.status,
        (select coalesce(jsonb_agg(jsonb_build_object('value', t.submission_value, 'decode', t.decode, 'nci_code', t.nci_code) order by t.ordinal), '[]')
           from core.codelist_term t where t.codelist_id = l.id) terms
      from core.codelist l where l.platform_id = $1 and l.status <> 'void' order by l.code, l.dictionary_version`, [params.id])).rows }) }),

  route({ method: 'get', path: '/v1/platforms/:id/crf-forms', summary: 'CRF library: forms with their versions', tag: 'edc', reqs: ['EDC-01'],
    handler: async ({ db, params }) => ({ items: (await db.query(`select f.id, f.oid, f.name, f.cdash_domain, f.status,
        (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'version_no', v.version_no, 'status', v.status, 'approved_at', v.approved_at,
            'items', (select count(*) from core.crf_item i where i.crf_version_id = v.id and i.status = 'active'),
            'checks', (select count(*) from core.crf_edit_check k where k.crf_version_id = v.id and k.status = 'active'),
            'visits', (select coalesce(jsonb_agg(d.code order by d.ordinal), '[]') from core.crf_visit l join core.visit_definition d on d.id = l.visit_definition_id
                       where l.crf_version_id = v.id and l.status = 'active')) order by v.version_no desc), '[]')
           from core.crf_version v where v.form_id = f.id and v.status <> 'void') versions
      from core.crf_form f where f.platform_id = $1 and f.status <> 'void' order by f.oid`, [params.id])).rows }) }),

  route<{ oid: string; name: string; cdash_domain?: string }>({ method: 'post', path: '/v1/platforms/:id/crf-forms', status: 201,
    summary: 'New CRF with an empty draft version 1', tag: 'edc', reqs: ['EDC-01'],
    body: { type: 'object', additionalProperties: false, required: ['oid', 'name'], properties: { oid: { type: 'string', pattern: '^F\\.[A-Z0-9_]{1,30}$' },
      name: { type: 'string', minLength: 1, maxLength: 200 }, cdash_domain: { type: 'string', pattern: '^[A-Z]{2}$' } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, LIBRARY_ROLES, 'Maintaining the CRF library');
      const f = await one(db, 'insert into core.crf_form(platform_id, oid, name, cdash_domain) values ($1,$2,$3,$4) returning id', [params.id, body.oid, body.name, body.cdash_domain ?? null]);
      return newDraft(db, f!.id);
    } }),

  route({ method: 'get', path: '/v1/crf-versions/:id', versioned: { table: 'crf_version', param: 'id' },
    summary: 'CRF version: items (CDASH metadata, units, codelists), edit checks, visits, approval signature', tag: 'edc', reqs: ['EDC-01', 'EDC-04', 'CMP-11'],
    handler: async ({ db, params }) => versionDetail(db, params.id!) }),

  route<{ copy_from?: string }>({ method: 'post', path: '/v1/crf-forms/:id/versions', status: 201,
    summary: 'New draft version of a CRF (copies the approved version unless copy_from is given)', tag: 'edc', reqs: ['EDC-01', 'DM-02'],
    body: { type: 'object', additionalProperties: false, properties: { copy_from: uuid } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, LIBRARY_ROLES, 'Maintaining the CRF library');
      if (!(await one(db, 'select id from core.crf_form where id = $1', [params.id]))) return undefined;
      if ((await one(db, "select id from core.crf_version where form_id = $1 and status = 'draft'", [params.id])))
        throw new HttpError(409, 'draft_exists', 'this CRF already has a draft version');
      return newDraft(db, params.id!, body.copy_from);
    } }),

  route<{ oid: string; cdash_variable: string; label: string; data_type: string; codelist_id?: string; unit_term_id?: string; required?: boolean; ordinal?: number }>({
    method: 'post', path: '/v1/crf-versions/:id/items', status: 201, summary: 'Add an item to a draft CRF version', tag: 'edc', reqs: ['EDC-01'],
    body: { type: 'object', additionalProperties: false, required: ['oid', 'cdash_variable', 'label', 'data_type'], properties: {
      oid: { type: 'string', pattern: '^I\\.[A-Z0-9_.]{1,40}$' }, cdash_variable: { type: 'string', pattern: '^[A-Z][A-Z0-9]{0,7}$' },
      label: { type: 'string', minLength: 1, maxLength: 200 }, data_type: { enum: ['integer', 'decimal', 'text', 'date', 'coded'] }, codelist_id: uuid,
      unit_term_id: uuid, required: { type: 'boolean' }, ordinal: { type: 'integer' } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, LIBRARY_ROLES, 'Maintaining the CRF library');
      await draft(db, params.id!);
      await db.query(`insert into core.crf_item(crf_version_id, oid, cdash_variable, label, data_type, codelist_id, unit_term_id, required, ordinal)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [params.id, body.oid, body.cdash_variable, body.label, body.data_type, body.codelist_id ?? null,
        body.unit_term_id ?? null, body.required ?? false, body.ordinal ?? 0]);
      return versionDetail(db, params.id!);
    } }),

  route<{ code: string; kind: string; item_oid: string; operator?: string; other_item_oid?: string; min_value?: number; max_value?: number; severity?: string; message: string }>({
    method: 'post', path: '/v1/crf-versions/:id/edit-checks', status: 201, summary: 'Declare an edit check on a draft CRF version', tag: 'edc', reqs: ['EDC-04'],
    body: { type: 'object', additionalProperties: false, required: ['code', 'kind', 'item_oid', 'message'], properties: {
      code: { type: 'string', pattern: '^EC\\.[A-Z0-9_.]{1,40}$' }, kind: { enum: ['required', 'range', 'compare'] }, item_oid: { type: 'string' },
      operator: { enum: ['<', '<=', '>', '>=', '=', '<>'] }, other_item_oid: { type: 'string' }, min_value: { type: 'number' }, max_value: { type: 'number' },
      severity: { enum: ['soft', 'hard'] }, message: { type: 'string', minLength: 1, maxLength: 500 } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, LIBRARY_ROLES, 'Maintaining the CRF library');
      await draft(db, params.id!);
      await db.query(`insert into core.crf_edit_check(crf_version_id, code, kind, item_oid, operator, other_item_oid, min_value, max_value, severity, message)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [params.id, body.code, body.kind, body.item_oid, body.operator ?? null, body.other_item_oid ?? null,
        body.min_value ?? null, body.max_value ?? null, body.severity ?? 'soft', body.message]);
      return versionDetail(db, params.id!);
    } }),

  route<{ visit_definition_id: string }>({ method: 'post', path: '/v1/crf-versions/:id/visits', status: 201,
    summary: 'Schedule a draft CRF version at a protocol visit', tag: 'edc', reqs: ['EDC-01'],
    body: { type: 'object', additionalProperties: false, required: ['visit_definition_id'], properties: { visit_definition_id: uuid } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, LIBRARY_ROLES, 'Maintaining the CRF library');
      await draft(db, params.id!);
      await db.query('insert into core.crf_visit(crf_version_id, visit_definition_id) values ($1,$2)', [params.id, body.visit_definition_id]);
      return versionDetail(db, params.id!);
    } }),

  route<{ password?: string; totp?: string }>({ method: 'post', path: '/v1/crf-versions/:id/approve', versioned: { table: 'crf_version', param: 'id' },
    needsReason: true, summary: 'Approve a draft CRF version with a Part 11 signature; the previous version is superseded', tag: 'edc',
    reqs: ['EDC-01', 'CMP-02', 'IAM-05', 'CMP-11'],
    body: { type: 'object', additionalProperties: false, properties: { password: { type: 'string' }, totp: { type: 'string', maxLength: 16 } } },
    handler: async ({ db, claims, params, body, services }) => {
      requireRole(claims, LIBRARY_ROLES, 'Approving a CRF version');
      await draft(db, params.id!);
      const sig = await sign(db, claims, services.reauth, { target_table: 'crf_version', target_id: params.id!, meaning: 'approval',
        credential: { password: body.password, totp: body.totp } });
      await db.query("update core.crf_version set status = 'approved', approved_signature_id = $2 where id = $1", [params.id, sig.id]);
      return versionDetail(db, params.id!);
    } }),

  // ----- EDC-03 data entry
  route({ method: 'get', path: '/v1/platforms/:id/edc/subjects', summary: 'Subjects for data entry with their visits and open queries (blinded)', tag: 'edc',
    reqs: ['EDC-03', 'EDC-11'], query: { site_id: uuid },
    handler: async ({ db, params, query }) => ({ items: (await db.query(`select ${SUBJECT_COLS}, st.site_number,
        (select count(*)::int from core.subject_visit v where v.subject_id = s.id and v.status <> 'void') visits,
        (select count(*)::int from core.subject_visit v where v.subject_id = s.id and v.status = 'completed') visits_completed,
        (select count(*)::int from core.edc_query q where q.subject_id = s.id and q.status in ('open', 'answered')) queries_open
      from core.subject_blinded s join core.site st on st.id = s.site_id
      where s.platform_id = $1 and ($2::uuid is null or s.site_id = $2)
        and s.status in ('consented', 'screening', 'screen_failed', 'randomized', 'on_treatment', 'completed', 'withdrawn')
        and core.edc_clinical_reader(s.platform_id)
      order by s.subject_code`, [params.id, query.site_id ?? null])).rows }) }),

  route({ method: 'get', path: '/v1/edc/subjects/:id', summary: 'Casebook of a subject: visit schedule and recorded visits (blinded)', tag: 'edc',
    reqs: ['EDC-03', 'EDC-11'],
    handler: async ({ db, params }) => {
      const s = await one(db, `select ${SUBJECT_COLS}, st.site_number from core.subject_blinded s join core.site st on st.id = s.site_id
        where s.id = $1 and core.edc_clinical_reader(s.platform_id)`, [params.id]);
      if (!s) return undefined;
      const schedule = (await db.query(`select d.id visit_definition_id, d.code, d.name, d.planned_day, v.id, v.visit_date::text visit_date, v.status, v.completed_at,
          (select count(*)::int from core.edc_query q join core.crf_entry e on e.id = q.crf_entry_id where e.subject_visit_id = v.id and q.status in ('open', 'answered')) queries_open
        from core.visit_definition d left join core.subject_visit v on v.visit_definition_id = d.id and v.subject_id = $1 and v.status <> 'void'
        where d.platform_id = $2 and d.status = 'active' order by d.ordinal`, [s.id, s.platform_id])).rows;
      return { ...s, schedule };
    } }),

  route<{ visit_definition_id: string; visit_date: string }>({ method: 'post', path: '/v1/edc/subjects/:id/visits', status: 201,
    summary: 'Start a visit of a subject (the visit date is checked against the server UTC date)', tag: 'edc', reqs: ['EDC-03'],
    body: { type: 'object', additionalProperties: false, required: ['visit_definition_id', 'visit_date'], properties: { visit_definition_id: uuid,
      visit_date: { type: 'string', format: 'date' } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, SITE_ROLES, 'Recording a visit');
      const v = await one(db, 'insert into core.subject_visit(subject_id, visit_definition_id, visit_date) values ($1,$2,$3) returning id',
        [params.id, body.visit_definition_id, body.visit_date]);
      return visitDetail(db, v!.id);
    } }),

  route({ method: 'get', path: '/v1/subject-visits/:id', versioned: { table: 'subject_visit', param: 'id' },
    summary: 'A subject visit with its forms, values, edit checks and queries (blinded)', tag: 'edc', reqs: ['EDC-03', 'EDC-04', 'EDC-05', 'EDC-11'],
    handler: async ({ db, params }) => visitDetail(db, params.id!) }),

  route<{ crf_form_id: string }>({ method: 'post', path: '/v1/subject-visits/:id/entries', status: 201,
    summary: 'Start a form at a visit with the current approved CRF version', tag: 'edc', reqs: ['EDC-03', 'EDC-01'],
    body: { type: 'object', additionalProperties: false, required: ['crf_form_id'], properties: { crf_form_id: uuid } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, SITE_ROLES, 'Entering data');
      await db.query('insert into core.crf_entry(subject_visit_id, crf_form_id) values ($1,$2)', [params.id, body.crf_form_id]);
      return visitDetail(db, params.id!);
    } }),

  route<{ values: ValueIn[] }>({ method: 'put', path: '/v1/crf-entries/:id/values',
    summary: 'Save values of a form (typed value or ND/NA/UNK); a change of a saved value needs X-Change-Reason; edit checks run on save',
    tag: 'edc', reqs: ['EDC-03', 'EDC-04', 'DM-03'],
    body: { type: 'object', additionalProperties: false, required: ['values'], properties: { values: { type: 'array', minItems: 1, maxItems: 200, items: {
      type: 'object', additionalProperties: false, required: ['item_oid'], properties: { item_oid: { type: 'string', maxLength: 60 },
        value: { type: ['string', 'number', 'null'] }, missing_reason: { enum: [...MISSING, null] } } } } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, SITE_ROLES, 'Entering data');
      const visitId = await entryVisit(db, params.id!);
      const before = (await db.query("select count(*)::int n from core.edc_query where crf_entry_id = $1", [params.id])).rows[0].n as number;
      for (const v of body.values) {
        const value = v.value === null || v.value === undefined || v.value === '' ? null : String(v.value);
        const missing = v.missing_reason ?? null;
        const cur = await one(db, 'select id, value, missing_reason from core.item_value where crf_entry_id = $1 and item_oid = $2', [params.id, v.item_oid]);
        if (!cur) {
          if (value === null && missing === null) continue;              // nothing entered for this item yet
          await db.query('insert into core.item_value(crf_entry_id, item_oid, value, missing_reason) values ($1,$2,$3,$4)', [params.id, v.item_oid, value, missing]);
        } else if (cur.value !== value || cur.missing_reason !== missing) {
          await db.query('update core.item_value set value = $2, missing_reason = $3 where id = $1', [cur.id, value, missing]);
        }
      }
      const opened = (await db.query("select count(*)::int n from core.edc_query where crf_entry_id = $1", [params.id])).rows[0].n - before;
      return { queries_opened: opened, visit: await visitDetail(db, visitId) };
    } }),

  route({ method: 'post', path: '/v1/crf-entries/:id/complete', summary: 'Mark a form complete (required edit checks run; hard failures refuse)',
    tag: 'edc', reqs: ['EDC-03', 'EDC-04'],
    handler: async ({ db, claims, params, reason }) => {
      requireRole(claims, SITE_ROLES, 'Completing a form');
      const visitId = await entryVisit(db, params.id!);
      await withReason(db, reason, 'Form completed');
      await db.query("update core.crf_entry set status = 'complete' where id = $1", [params.id]);
      return visitDetail(db, visitId);
    } }),

  route({ method: 'post', path: '/v1/crf-entries/:id/reopen', needsReason: true, summary: 'Reopen a complete form', tag: 'edc', reqs: ['EDC-03', 'DM-03'],
    handler: async ({ db, claims, params }) => {
      requireRole(claims, SITE_ROLES, 'Reopening a form');
      const visitId = await entryVisit(db, params.id!);
      await db.query("update core.crf_entry set status = 'in_progress' where id = $1", [params.id]);
      return visitDetail(db, visitId);
    } }),

  route({ method: 'post', path: '/v1/crf-entries/:id/run-checks', summary: 'Run every edit check of a form again (batch); returns the queries opened',
    tag: 'edc', reqs: ['EDC-04'],
    handler: async ({ db, params, reason }) => {
      await entryVisit(db, params.id!);
      await withReason(db, reason, 'Batch edit check run');
      return { queries_opened: (await db.query('select core.edc_run_checks($1) n', [params.id])).rows[0].n };
    } }),

  route({ method: 'get', path: '/v1/item-values/:id/history', summary: 'Prior values of an item with author, server time and reason (audit trail)',
    tag: 'edc', reqs: ['EDC-03', 'CMP-04'],
    handler: async ({ db, params }) => ({ items: (await db.query('select * from core.item_value_history($1)', [params.id])).rows }) }),

  route({ method: 'post', path: '/v1/subject-visits/:id/complete', summary: 'Complete a visit (all scheduled forms complete); emits visit.completed',
    tag: 'edc', reqs: ['EDC-03', 'EDC-12'],
    handler: async ({ db, claims, params, reason }) => {
      requireRole(claims, SITE_ROLES, 'Completing a visit');
      if (!(await one(db, 'select id from core.subject_visit where id = $1', [params.id]))) return undefined;
      await withReason(db, reason, 'Visit completed');
      await db.query("update core.subject_visit set status = 'completed' where id = $1", [params.id]);
      return visitDetail(db, params.id!);
    } }),

  // ----- EDC-05 queries
  route({ method: 'get', path: '/v1/platforms/:id/edc-queries', summary: 'Data queries of the platform (filter by status and site)', tag: 'edc',
    reqs: ['EDC-05', 'EDC-11'], query: { status: { enum: ['open', 'answered', 'closed', 'cancelled'] }, site_id: uuid },
    handler: async ({ db, params, query }) => ({ items: (await db.query(`select q.id, q.status, q.origin, q.question, q.answer, q.close_reason,
        q.opened_by, q.opened_at, q.answered_by, q.answered_at, q.closed_by, q.closed_at, q.subject_id, s.subject_code, st.site_number, q.site_id,
        e.subject_visit_id, d.code visit_code, f.oid form_oid, i.oid item_oid, i.label item_label, k.code check_code, v.value, v.missing_reason
      from core.edc_query q join core.crf_entry e on e.id = q.crf_entry_id join core.subject_visit sv on sv.id = e.subject_visit_id
      join core.visit_definition d on d.id = sv.visit_definition_id join core.crf_form f on f.id = e.crf_form_id
      join core.subject_blinded s on s.id = q.subject_id join core.site st on st.id = q.site_id
      left join core.crf_item i on i.id = q.crf_item_id left join core.crf_edit_check k on k.id = q.edit_check_id
      left join core.item_value v on v.id = q.item_value_id
      where q.platform_id = $1 and ($2::text is null or q.status = $2) and ($3::uuid is null or q.site_id = $3)
      order by case q.status when 'open' then 0 when 'answered' then 1 else 2 end, q.opened_at desc`, [params.id, query.status ?? null, query.site_id ?? null])).rows }) }),

  route<{ item_oid?: string; question: string }>({ method: 'post', path: '/v1/crf-entries/:id/queries', status: 201,
    summary: 'Open a manual query on a form or an item (data manager or monitor)', tag: 'edc', reqs: ['EDC-05'],
    body: { type: 'object', additionalProperties: false, required: ['question'], properties: { item_oid: { type: 'string' },
      question: { type: 'string', minLength: 1, maxLength: 2000 } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, REVIEW_ROLES, 'Opening a query');
      const e = await one(db, 'select id, crf_version_id from core.crf_entry where id = $1', [params.id]);
      if (!e) return undefined;
      const item = body.item_oid ? await one(db, 'select id from core.crf_item where crf_version_id = $1 and oid = $2', [e.crf_version_id, body.item_oid]) : undefined;
      if (body.item_oid && !item) throw new HttpError(422, 'unknown_item', `item ${body.item_oid} is not in this form`);
      const val = item ? await one(db, "select id from core.item_value where crf_entry_id = $1 and crf_item_id = $2", [e.id, item.id]) : undefined;
      const q = await one(db, `insert into core.edc_query(crf_entry_id, crf_item_id, item_value_id, origin, question) values ($1,$2,$3,'manual',$4) returning id`,
        [e.id, item?.id ?? null, val?.id ?? null, body.question]);
      return queryRow(db, q!.id);
    } }),

  route<{ answer: string }>({ method: 'post', path: '/v1/edc-queries/:id/answer', summary: 'Answer a query (site)', tag: 'edc', reqs: ['EDC-05'],
    body: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string', minLength: 1, maxLength: 2000 } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, SITE_ROLES, 'Answering a query');
      return moveQuery(db, params.id!, 'answered', { answer: body.answer }, `Query answered: ${body.answer}`.slice(0, 2000));
    } }),

  route<{ reason: string }>({ method: 'post', path: '/v1/edc-queries/:id/close', summary: 'Close a query with a reason (data manager or monitor)', tag: 'edc',
    reqs: ['EDC-05'], body: reasonBody,
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, REVIEW_ROLES, 'Closing a query');
      return moveQuery(db, params.id!, 'closed', { close_reason: body.reason }, body.reason);
    } }),

  route<{ reason: string }>({ method: 'post', path: '/v1/edc-queries/:id/cancel', summary: 'Cancel an open query with a reason (data manager or monitor)',
    tag: 'edc', reqs: ['EDC-05'], body: reasonBody,
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, REVIEW_ROLES, 'Cancelling a query');
      return moveQuery(db, params.id!, 'cancelled', { close_reason: body.reason }, body.reason);
    } }),

  route<{ reason: string }>({ method: 'post', path: '/v1/edc-queries/:id/requery', summary: 'Re-open an answered query (the answer stays in the audit trail)',
    tag: 'edc', reqs: ['EDC-05'], body: reasonBody,
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, REVIEW_ROLES, 'Re-opening a query');
      return moveQuery(db, params.id!, 'open', {}, body.reason);
    } }),
];
