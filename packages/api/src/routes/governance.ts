// Quality governance (CMP-05, ICH E6(R3)): critical-to-quality factors, RBQM risk register, KRIs and quality tolerance
// limits with breach detection, reconstruction of the decisions of an arm, and the service provider registry with
// agreements and oversight (shared with CMP-08 and VAL-04). The database (0026) is the enforcement point: roles, author and
// time, state machines, agreement and oversight checks; the API validates input and adds early role checks.
import { route, uuid } from '../route.ts';
import type { Db, Row } from '../db.ts';
import type { Claims } from '../auth.ts';
import { requirePerson, requireRole, type Role } from '../lib/roles.ts';
import { HttpError } from '../errors.ts';

const RBQM: Role[] = ['platform_admin', 'platform_ops_manager', 'qa_auditor'];
const PROVIDERS: Role[] = ['platform_admin', 'qa_auditor'];
const CODE = { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_.-]{0,39}$' } as const;
const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max }) as const;
const score = { type: 'integer', minimum: 1, maximum: 5 } as const;
const CATEGORIES = ['operational', 'sponsor_confidential', 'pseudonymised_clinical', 'identifiable_health'];
const REGIONS = ['EU', 'US', 'JP'];
const DATE = { type: 'string', format: 'date' } as const;
const SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;

const RISK_COLS = `id, platform_id, arm_id, ctq_factor_id, code, description, likelihood, impact, detectability, risk_score, controls, owner_role,
  status, review_due, created_by, created_at, updated_at, row_version`;
const LIMIT_COLS = `id, platform_id, arm_id, ctq_factor_id, risk_id, code, kind, metric, description, unit, lower_limit, upper_limit, status,
  created_by, created_at, updated_at, row_version`;
const PROVIDER_COLS = `id, code, name, org_id, kind, responsibilities, data_categories, processing_regions, gxp_relevant, status,
  review_interval_months, created_by, created_at, updated_at, row_version`;

function quality(claims: Claims, roles: Role[], action: string): void {
  requirePerson(claims, action);
  requireRole(claims, roles, action);
}

async function provider(db: Db, id: string): Promise<Row | undefined> {
  const p = (await db.query(`select ${PROVIDER_COLS} from core.service_provider where id = $1`, [id])).rows[0];
  if (!p) return undefined;
  const agreements = (await db.query(`select id, kind, data_categories, regions, effective_from, expires_on, document_ref, document_sha256, status,
    created_by, created_at from core.provider_agreement where provider_id = $1 and status <> 'void' order by kind, effective_from`, [id])).rows;
  const oversight = (await db.query(`select id, kind, performed_on, outcome, findings, capa_ref, recorded_by, recorded_at from core.provider_oversight_activity
    where provider_id = $1 and status = 'recorded' order by performed_on desc, recorded_at desc`, [id])).rows;
  const status = (await db.query('select last_activity_on, next_review_due, overdue, agreement_gaps from core.provider_oversight_status() where provider_id = $1', [id])).rows[0];
  const gaps = (await db.query('select kind, category, region from core.provider_agreement_gaps($1, $2, $3, $4)',
    [id, p.data_categories, p.processing_regions, p.gxp_relevant])).rows;
  return { ...p, agreements, oversight, oversight_status: status ?? null, agreement_gaps: gaps };
}

interface CtqBody { arm_id?: string; code: string; title: string; category: string; rationale: string }
interface RiskBody { arm_id?: string; ctq_factor_id: string; code: string; description: string; likelihood: number; impact: number;
  detectability: number; controls: string; owner_role: string; review_due?: string }
interface RiskPatch { likelihood?: number; impact?: number; detectability?: number; controls?: string; status?: string; review_due?: string }
interface LimitBody { arm_id?: string; ctq_factor_id: string; risk_id?: string; code: string; kind: 'KRI' | 'QTL'; metric: string; description: string;
  unit: string; lower_limit?: number; upper_limit?: number }

export const governanceRoutes = [
  // ---- CtQ factors ----
  route({ method: 'get', path: '/v1/platforms/:id/ctq-factors', tag: 'quality', reqs: ['CMP-05'],
    summary: 'Critical-to-quality factors of a platform (and its arms), with their risks and limits',
    handler: async ({ db, params }) => {
      const factors = (await db.query(`select id, platform_id, arm_id, code, title, category, rationale, status, created_by, created_at, row_version
        from core.ctq_factor where platform_id = $1 and status <> 'void' order by arm_id nulls first, code`, [params.id])).rows;
      const risks = (await db.query(`select ${RISK_COLS} from core.quality_risk where platform_id = $1 and status <> 'void' order by risk_score desc, code`, [params.id])).rows;
      const limits = (await db.query(`select ${LIMIT_COLS} from core.quality_tolerance_limit where platform_id = $1 and status <> 'void' order by code`, [params.id])).rows;
      return { items: factors.map(f => ({ ...f, risks: risks.filter(r => r.ctq_factor_id === f.id), limits: limits.filter(l => l.ctq_factor_id === f.id) })) };
    } }),

  route<CtqBody>({ method: 'post', path: '/v1/platforms/:id/ctq-factors', status: 201, tag: 'quality', reqs: ['CMP-05'],
    summary: 'Record a critical-to-quality factor (platform or arm level)',
    body: { type: 'object', additionalProperties: false, required: ['code', 'title', 'category', 'rationale'], properties: {
      arm_id: uuid, code: CODE, title: text(300), category: { enum: ['participant_protection', 'data_reliability', 'trial_conduct', 'other'] },
      rationale: text(4000) } },
    handler: async ({ db, claims, params, body }) => {
      quality(claims, RBQM, 'Recording a CtQ factor');
      return (await db.query(`insert into core.ctq_factor(platform_id, arm_id, code, title, category, rationale) values ($1, $2, $3, $4, $5, $6)
        returning id, platform_id, arm_id, code, title, category, rationale, status, created_by, created_at, row_version`,
      [params.id, body.arm_id ?? null, body.code, body.title, body.category, body.rationale])).rows[0];
    } }),

  // ---- risks ----
  route<RiskBody>({ method: 'post', path: '/v1/platforms/:id/quality-risks', status: 201, tag: 'quality', reqs: ['CMP-05'],
    summary: 'Add a risk to the RBQM register: likelihood, impact, detectability (1-5), controls, owner',
    body: { type: 'object', additionalProperties: false, required: ['ctq_factor_id', 'code', 'description', 'likelihood', 'impact', 'detectability', 'controls', 'owner_role'],
      properties: { arm_id: uuid, ctq_factor_id: uuid, code: CODE, description: text(4000), likelihood: score, impact: score, detectability: score,
        controls: text(4000), owner_role: { type: 'string', pattern: '^[a-z_]{2,40}$' }, review_due: DATE } },
    handler: async ({ db, claims, params, body }) => {
      quality(claims, RBQM, 'Adding a quality risk');
      return (await db.query(`insert into core.quality_risk(platform_id, arm_id, ctq_factor_id, code, description, likelihood, impact, detectability, controls,
        owner_role, review_due) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${RISK_COLS}`,
      [params.id, body.arm_id ?? null, body.ctq_factor_id, body.code, body.description, body.likelihood, body.impact, body.detectability, body.controls,
        body.owner_role, body.review_due ?? null])).rows[0];
    } }),

  route<RiskPatch>({ method: 'patch', path: '/v1/quality-risks/:id', versioned: { table: 'quality_risk', param: 'id' }, needsReason: true, tag: 'quality',
    reqs: ['CMP-05'], summary: 'Re-assess a risk or change its status (open, mitigated, accepted, closed, void); reason required, audited',
    body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { likelihood: score, impact: score, detectability: score,
      controls: text(4000), status: { enum: ['open', 'mitigated', 'accepted', 'closed', 'void'] }, review_due: DATE } },
    handler: async ({ db, claims, params, body }) => {
      quality(claims, RBQM, 'Re-assessing a quality risk');
      return (await db.query(`update core.quality_risk set likelihood = coalesce($2, likelihood), impact = coalesce($3, impact),
        detectability = coalesce($4, detectability), controls = coalesce($5, controls), status = coalesce($6, status), review_due = coalesce($7::date, review_due)
        where id = $1 returning ${RISK_COLS}`, [params.id, body.likelihood ?? null, body.impact ?? null, body.detectability ?? null, body.controls ?? null,
        body.status ?? null, body.review_due ?? null])).rows[0];
    } }),

  // ---- KRI / QTL ----
  route<LimitBody>({ method: 'post', path: '/v1/platforms/:id/quality-limits', status: 201, tag: 'quality', reqs: ['CMP-05'],
    summary: 'Define a key risk indicator or quality tolerance limit (metric, unit, lower and/or upper limit)',
    body: { type: 'object', additionalProperties: false, required: ['ctq_factor_id', 'code', 'kind', 'metric', 'description', 'unit'],
      properties: { arm_id: uuid, ctq_factor_id: uuid, risk_id: uuid, code: CODE, kind: { enum: ['KRI', 'QTL'] },
        metric: { type: 'string', pattern: '^[a-z0-9_.]{1,60}$' }, description: text(2000), unit: text(40),
        lower_limit: { type: 'number' }, upper_limit: { type: 'number' } } },
    handler: async ({ db, claims, params, body }) => {
      quality(claims, RBQM, 'Defining a KRI/QTL');
      if (body.lower_limit === undefined && body.upper_limit === undefined) throw new HttpError(400, 'invalid_body', 'a lower or an upper limit is required');
      return (await db.query(`insert into core.quality_tolerance_limit(platform_id, arm_id, ctq_factor_id, risk_id, code, kind, metric, description, unit,
        lower_limit, upper_limit) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${LIMIT_COLS}`,
      [params.id, body.arm_id ?? null, body.ctq_factor_id, body.risk_id ?? null, body.code, body.kind, body.metric, body.description, body.unit,
        body.lower_limit ?? null, body.upper_limit ?? null])).rows[0];
    } }),

  route<{ value: number; note?: string }>({ method: 'post', path: '/v1/quality-limits/:id/observations', status: 201, tag: 'quality', reqs: ['CMP-05'],
    summary: 'Record an observed value; a value outside the limit is a breach (review task + event)',
    body: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'number' }, note: { type: 'string', maxLength: 2000 } } },
    handler: async ({ db, claims, params, body }) => {
      quality(claims, [...RBQM, 'data_manager'], 'Recording a KRI/QTL observation');
      const l = (await db.query('select platform_id from core.quality_tolerance_limit where id = $1', [params.id])).rows[0];
      if (!l) return undefined;
      return (await db.query(`insert into core.qtl_observation(limit_id, platform_id, value, source, note) values ($1, $2, $3, 'manual', $4)
        returning id, limit_id, platform_id, arm_id, value, source, note, breached, breach_task_id, observed_by, observed_at`,
      [params.id, l.platform_id, body.value, body.note ?? null])).rows[0];
    } }),

  route({ method: 'post', path: '/v1/platforms/:id/quality-limits/evaluate', tag: 'quality', reqs: ['CMP-05'],
    summary: 'Compute every platform-level KRI/QTL from the records and record the observations (breaches detected)',
    handler: async ({ db, claims, params }) => {
      quality(claims, RBQM, 'Evaluating KRIs/QTLs');
      const items = (await db.query(`select o.id, o.limit_id, l.code, l.kind, l.metric, o.value, l.lower_limit, l.upper_limit, o.breached, o.breach_task_id, o.observed_at
        from core.rbqm_evaluate($1) o join core.quality_tolerance_limit l on l.id = o.limit_id order by l.code`, [params.id])).rows;
      return { items, breaches: items.filter(i => i.breached).length };
    } }),

  route({ method: 'get', path: '/v1/platforms/:id/quality-limits/observations', tag: 'quality', reqs: ['CMP-05'],
    summary: 'Observations of the KRIs/QTLs of a platform, newest first (breached=true for breaches only)',
    query: { breached: { enum: ['true', 'false'] } },
    handler: async ({ db, params, query }) => ({
      items: (await db.query(`select o.id, o.limit_id, l.code, l.kind, l.metric, l.unit, o.value, l.lower_limit, l.upper_limit, o.source, o.note, o.breached,
        o.breach_task_id, o.observed_by, o.observed_at from core.qtl_observation o join core.quality_tolerance_limit l on l.id = o.limit_id
        where o.platform_id = $1 and ($2::boolean is null or o.breached = $2) order by o.observed_at desc limit 500`,
      [params.id, query.breached === undefined ? null : query.breached === 'true'])).rows,
    }) }),

  // ---- reconstruction ----
  route({ method: 'get', path: '/v1/arms/:id/decision-timeline', tag: 'quality', reqs: ['CMP-05'],
    summary: 'Every decision and adaptation of an arm in time order: audit trail, signatures, AI requests, agent decisions, events (QA/admin)',
    handler: async ({ db, claims, params }) => {
      quality(claims, ['qa_auditor', 'platform_admin'], 'Reconstructing the decisions of an arm');
      const items = (await db.query('select * from core.arm_decision_timeline($1)', [params.id])).rows;
      return { arm_id: params.id, items };
    } }),

  // ---- service providers ----
  route({ method: 'get', path: '/v1/service-providers', tag: 'providers', reqs: ['CMP-05', 'CMP-08'],
    summary: 'Service provider registry with oversight status (last activity, next review, overdue) and agreement gaps',
    handler: async ({ db }) => ({ items: (await db.query(`select p.id, p.code, p.name, p.kind, p.status, p.data_categories, p.processing_regions, p.gxp_relevant,
      s.last_activity_on, s.last_outcome, s.next_review_due, s.overdue, s.agreement_gaps
      from core.service_provider p left join core.provider_oversight_status() s on s.provider_id = p.id where p.status <> 'void' order by p.code`)).rows }) }),

  route({ method: 'get', path: '/v1/service-providers/:id', versioned: { table: 'service_provider', param: 'id' }, tag: 'providers', reqs: ['CMP-05', 'CMP-08'],
    summary: 'A service provider with its agreements, oversight activities and missing agreements',
    handler: async ({ db, params }) => provider(db, params.id!) }),

  route<{ code: string; name: string; org_id?: string; kind: string; responsibilities: string; data_categories: string[]; processing_regions: string[];
    gxp_relevant?: boolean; review_interval_months?: number }>({ method: 'post', path: '/v1/service-providers', status: 201, tag: 'providers', reqs: ['CMP-05', 'CMP-08'],
    summary: 'Register a service provider (status proposed): responsibilities, data categories, processing regions',
    body: { type: 'object', additionalProperties: false, required: ['code', 'name', 'kind', 'responsibilities', 'data_categories', 'processing_regions'], properties: {
      code: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{1,59}$' }, name: text(200), org_id: uuid,
      kind: { enum: ['hosting', 'database', 'ai', 'app_supplier', 'cro', 'laboratory', 'technology', 'other'] }, responsibilities: text(4000),
      data_categories: { type: 'array', uniqueItems: true, items: { enum: CATEGORIES } },
      processing_regions: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: REGIONS } },
      gxp_relevant: { type: 'boolean' }, review_interval_months: { type: 'integer', minimum: 1, maximum: 60 } } },
    handler: async ({ db, claims, body }) => {
      quality(claims, PROVIDERS, 'Registering a service provider');
      const id = (await db.query(`insert into core.service_provider(code, name, org_id, kind, responsibilities, data_categories, processing_regions, gxp_relevant,
        review_interval_months) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`, [body.code, body.name, body.org_id ?? null, body.kind,
        body.responsibilities, body.data_categories, body.processing_regions, body.gxp_relevant ?? true, body.review_interval_months ?? 12])).rows[0].id;
      return provider(db, id);
    } }),

  route<{ to: string }>({ method: 'post', path: '/v1/service-providers/:id/status', versioned: { table: 'service_provider', param: 'id' }, needsReason: true,
    tag: 'providers', reqs: ['CMP-05', 'CMP-08'],
    summary: 'Move a provider through proposed -> qualified -> active -> suspended / terminated; activation needs valid agreements and current oversight',
    body: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { enum: ['qualified', 'active', 'suspended', 'terminated', 'void'] } } },
    handler: async ({ db, claims, params, body }) => {
      quality(claims, PROVIDERS, 'Changing the status of a service provider');
      const r = await db.query('update core.service_provider set status = $2 where id = $1 returning id', [params.id, body.to]);
      return r.rowCount ? provider(db, params.id!) : undefined;
    } }),

  route<{ kind: string; data_categories?: string[]; regions?: string[]; effective_from: string; expires_on?: string; document_ref: string;
    document_sha256?: string; status?: 'draft' | 'effective' }>({ method: 'post', path: '/v1/service-providers/:id/agreements', status: 201, tag: 'providers',
    reqs: ['CMP-08', 'CMP-05'], summary: 'Record a DPA, BAA, APPI transfer basis, SCC or quality agreement (effective needs the SHA-256 of the signed document)',
    body: { type: 'object', additionalProperties: false, required: ['kind', 'effective_from', 'document_ref'], properties: {
      kind: { enum: ['DPA', 'BAA', 'APPI_TRANSFER', 'SCC', 'QUALITY_AGREEMENT'] },
      data_categories: { type: 'array', uniqueItems: true, items: { enum: CATEGORIES } }, regions: { type: 'array', uniqueItems: true, items: { enum: REGIONS } },
      effective_from: DATE, expires_on: DATE, document_ref: text(1000), document_sha256: SHA256, status: { enum: ['draft', 'effective'] } } },
    handler: async ({ db, claims, params, body }) => {
      quality(claims, PROVIDERS, 'Recording a provider agreement');
      return (await db.query(`insert into core.provider_agreement(provider_id, kind, data_categories, regions, effective_from, expires_on, document_ref,
        document_sha256, status) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, provider_id, kind, data_categories, regions, effective_from, expires_on,
        document_ref, document_sha256, status, created_by, created_at`, [params.id, body.kind, body.data_categories ?? [], body.regions ?? [], body.effective_from,
        body.expires_on ?? null, body.document_ref, body.document_sha256 ?? null, body.status ?? 'draft'])).rows[0];
    } }),

  route<{ to: string }>({ method: 'post', path: '/v1/provider-agreements/:id/status', versioned: { table: 'provider_agreement', param: 'id' }, needsReason: true,
    tag: 'providers', reqs: ['CMP-08'], summary: 'Make an agreement effective, terminate it or void a draft; content of an effective agreement never changes',
    body: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { enum: ['effective', 'terminated', 'void'] } } },
    handler: async ({ db, claims, params, body }) => {
      quality(claims, PROVIDERS, 'Changing an agreement');
      return (await db.query(`update core.provider_agreement set status = $2 where id = $1 returning id, provider_id, kind, data_categories, regions,
        effective_from, expires_on, document_ref, document_sha256, status`, [params.id, body.to])).rows[0];
    } }),

  route<{ kind: string; performed_on: string; outcome: string; findings?: string; capa_ref?: string }>({ method: 'post',
    path: '/v1/service-providers/:id/oversight', status: 201, tag: 'providers', reqs: ['CMP-05'],
    summary: 'Record an oversight activity (qualification, periodic review, audit, KPI or incident review); the next review date follows',
    body: { type: 'object', additionalProperties: false, required: ['kind', 'performed_on', 'outcome'], properties: {
      kind: { enum: ['qualification', 'periodic_review', 'audit', 'kpi_review', 'incident_review', 'requalification'] }, performed_on: DATE,
      outcome: { enum: ['satisfactory', 'satisfactory_with_findings', 'unsatisfactory'] }, findings: { type: 'string', maxLength: 4000 },
      capa_ref: { type: 'string', maxLength: 200 } } },
    handler: async ({ db, claims, params, body }) => {
      quality(claims, PROVIDERS, 'Recording provider oversight');
      return (await db.query(`insert into core.provider_oversight_activity(provider_id, kind, performed_on, outcome, findings, capa_ref)
        values ($1, $2, $3, $4, $5, $6) returning id, provider_id, kind, performed_on, outcome, findings, capa_ref, recorded_by, recorded_at`,
      [params.id, body.kind, body.performed_on, body.outcome, body.findings ?? null, body.capa_ref ?? null])).rows[0];
    } }),
];
