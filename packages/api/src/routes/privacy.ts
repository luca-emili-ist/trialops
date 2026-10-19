// Privacy by design (CMP-08; GDPR art. 25/30/32/44, HIPAA §164.312, APPI): data region of a platform, providers used by a
// platform (residency and agreements checked by the database on activation), record of processing activities as versioned
// data, and the privacy self-check. The re-identification link is never served by the API: it lives in the SAC enclave
// (0026) and is read only by the enclave function, for unblinded SAC persons, with a logged reason.
import { route, uuid } from '../route.ts';
import type { Claims } from '../auth.ts';
import { requirePerson, requireRole, type Role } from '../lib/roles.ts';
import { HttpError } from '../errors.ts';

const PRIVACY: Role[] = ['platform_admin', 'qa_auditor'];
const CATEGORIES = ['operational', 'sponsor_confidential', 'pseudonymised_clinical', 'identifiable_health'];
const REGIONS = ['EU', 'US', 'JP'];
const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max }) as const;
const ROPA_COLS = `id, code, version, title, controller, purpose, legal_basis_eu, legal_basis_us, legal_basis_jp, data_subject_categories, data_categories,
  recipients, regions, transfers, retention, security_measures, status, approved_by, approved_at, created_by, created_at, updated_at, row_version`;

function privacy(claims: Claims, action: string): void {
  requirePerson(claims, action);
  requireRole(claims, PRIVACY, action);
}

interface RopaBody { code: string; title: string; controller: string; purpose: string; legal_basis_eu?: string; legal_basis_us?: string; legal_basis_jp?: string;
  data_subject_categories: string[]; data_categories: string[]; recipients?: string[]; regions: string[]; transfers?: string; retention: string;
  security_measures: string }

export const privacyRoutes = [
  route<{ region: 'EU' | 'US' | 'JP' }>({ method: 'post', path: '/v1/platforms/:id/data-region', versioned: { table: 'platform', param: 'id' }, needsReason: true,
    tag: 'privacy', reqs: ['CMP-08'], summary: 'Declare the region where the data of the platform stays (EU, US or JP); set once',
    body: { type: 'object', additionalProperties: false, required: ['region'], properties: { region: { enum: REGIONS } } },
    handler: async ({ db, claims, params, body }) => {
      privacy(claims, 'Declaring the data region');
      return (await db.query('update core.platform set data_region = $2 where id = $1 returning id, code, data_region, row_version', [params.id, body.region])).rows[0];
    } }),

  route({ method: 'get', path: '/v1/platforms/:id/providers', tag: 'privacy', reqs: ['CMP-08'],
    summary: 'Providers used by a platform, the data categories they receive and whether participant data may go to them now',
    handler: async ({ db, params }) => ({
      items: (await db.query(`select u.id, u.platform_id, u.provider_id, p.code, p.name, p.kind, p.processing_regions, u.data_categories, u.purpose, u.status,
        u.created_by, u.created_at, pl.data_region,
        coalesce((select bool_and(core.provider_allowed(u.platform_id, p.code, c)) from unnest(u.data_categories) c), true) as allowed_now
        from core.platform_provider u join core.service_provider p on p.id = u.provider_id join core.platform pl on pl.id = u.platform_id
        where u.platform_id = $1 and u.status <> 'void' order by p.code`, [params.id])).rows,
    }) }),

  route<{ provider_id: string; data_categories: string[]; purpose: string }>({ method: 'post', path: '/v1/platforms/:id/providers', status: 201, tag: 'privacy',
    reqs: ['CMP-08'], summary: 'Use a provider on a platform; participant data only to an active provider processing in the platform region, with agreements',
    body: { type: 'object', additionalProperties: false, required: ['provider_id', 'data_categories', 'purpose'], properties: {
      provider_id: uuid, data_categories: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: CATEGORIES } }, purpose: text(1000) } },
    handler: async ({ db, claims, params, body }) => {
      privacy(claims, 'Using a provider on a platform');
      return (await db.query(`insert into core.platform_provider(platform_id, provider_id, data_categories, purpose) values ($1, $2, $3, $4)
        returning id, platform_id, provider_id, data_categories, purpose, status, created_by, created_at`, [params.id, body.provider_id, body.data_categories, body.purpose])).rows[0];
    } }),

  route({ method: 'post', path: '/v1/platform-providers/:id/end', versioned: { table: 'platform_provider', param: 'id' }, needsReason: true, tag: 'privacy',
    reqs: ['CMP-08'], summary: 'Stop using a provider on a platform (status ended; never deleted)',
    handler: async ({ db, claims, params }) => {
      privacy(claims, 'Ending the use of a provider');
      return (await db.query(`update core.platform_provider set status = 'ended' where id = $1 returning id, platform_id, provider_id, data_categories, purpose, status`,
        [params.id])).rows[0];
    } }),

  route({ method: 'get', path: '/v1/privacy/ropa', tag: 'privacy', reqs: ['CMP-08'],
    summary: 'Record of processing activities (GDPR art. 30): current approved versions, or every version with all=true',
    query: { all: { enum: ['true', 'false'] }, code: { type: 'string', pattern: '^ROPA-[0-9]{3}$' } },
    handler: async ({ db, query }) => ({
      items: (await db.query(`select ${ROPA_COLS} from core.ropa_entry where status <> 'void' and ($1 or status in ('approved', 'draft'))
        and ($2::text is null or code = $2) order by code, version desc`, [query.all === 'true', query.code ?? null])).rows,
    }) }),

  route<RopaBody>({ method: 'post', path: '/v1/privacy/ropa', status: 201, tag: 'privacy', reqs: ['CMP-08'],
    summary: 'Draft a new ROPA entry or the next version of an existing one (the version number is assigned)',
    body: { type: 'object', additionalProperties: false, required: ['code', 'title', 'controller', 'purpose', 'data_subject_categories', 'data_categories', 'regions',
      'retention', 'security_measures'], properties: {
      code: { type: 'string', pattern: '^ROPA-[0-9]{3}$' }, title: text(300), controller: text(300), purpose: text(4000),
      legal_basis_eu: text(1000), legal_basis_us: text(1000), legal_basis_jp: text(1000),
      data_subject_categories: { type: 'array', minItems: 1, items: text(200) }, data_categories: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: CATEGORIES } },
      recipients: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{1,59}$' } },
      regions: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: REGIONS } }, transfers: text(2000), retention: text(1000), security_measures: text(4000) } },
    handler: async ({ db, claims, body }) => {
      privacy(claims, 'Drafting a ROPA entry');
      const next = (await db.query('select coalesce(max(version), 0) + 1 v from core.ropa_entry where code = $1', [body.code])).rows[0].v;
      return (await db.query(`insert into core.ropa_entry(code, version, title, controller, purpose, legal_basis_eu, legal_basis_us, legal_basis_jp,
        data_subject_categories, data_categories, recipients, regions, transfers, retention, security_measures)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning ${ROPA_COLS}`,
      [body.code, next, body.title, body.controller, body.purpose, body.legal_basis_eu ?? null, body.legal_basis_us ?? null, body.legal_basis_jp ?? null,
        body.data_subject_categories, body.data_categories, body.recipients ?? [], body.regions, body.transfers ?? 'none', body.retention, body.security_measures])).rows[0];
    } }),

  route({ method: 'post', path: '/v1/privacy/ropa/:id/approve', versioned: { table: 'ropa_entry', param: 'id' }, needsReason: true, tag: 'privacy', reqs: ['CMP-08'],
    summary: 'Approve a ROPA draft (not by its author); the previous approved version is superseded, approved versions never change',
    handler: async ({ db, claims, params }) => {
      privacy(claims, 'Approving a ROPA entry');
      return (await db.query(`update core.ropa_entry set status = 'approved' where id = $1 returning ${ROPA_COLS}`, [params.id])).rows[0];
    } }),

  route({ method: 'get', path: '/v1/privacy/check', tag: 'privacy', reqs: ['CMP-08'],
    summary: 'Privacy self-check: pseudonymisation, minimisation, enclave-only re-identification, blinding grants, residency, agreements, ROPA',
    query: { platform_id: uuid },
    handler: async ({ db, claims, query }) => {
      privacy(claims, 'Running the privacy check');
      if (query.platform_id && !/^[0-9a-f-]{36}$/i.test(query.platform_id)) throw new HttpError(400, 'invalid_filter', 'platform_id must be a uuid');
      const items = (await db.query('select check_code, subject, ok, detail from core.privacy_check($1)', [query.platform_id ?? null])).rows;
      return { ok: items.every(i => i.ok), items };
    } }),
];
