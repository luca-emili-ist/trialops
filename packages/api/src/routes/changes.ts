// Change requests ("Suggest changes", UX-02): any person suggests a change on a numbered component of a page; platform
// admins triage them (TRO-060). The database is the enforcement point (0020): author, time and initial status are set
// there, only admins move the status and the note, every change is audited, and "delete" is a void with a reason.
import { route, uuid } from '../route.ts';
import type { Row } from '../db.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { HttpError } from '../errors.ts';

const reqs = ['UX-02'];
export const CHANGE_STATUSES = ['new', 'triaged', 'in_progress', 'done', 'rejected'] as const;
const OPEN = ['new', 'triaged', 'in_progress'];
const COLS = `id, platform_id, page_code, component_code, component_kind, component_text, dom_path, route, kind, request, status,
  triage_note, created_by, created_email, created_at, updated_by, updated_at`;
const PAGE = /^[A-Z]{2,4}-\d{3}$/;

interface SuggestBody { platform_id: string; page_code: string; component_code?: string; component_kind?: string; component_text?: string;
  dom_path?: string; route?: string; kind: 'change' | 'bug' | 'new'; request: string }
interface TriageBody { status?: string; triage_note?: string }

export const changeRoutes = [
  route<SuggestBody>({ method: 'post', path: '/v1/change-requests', status: 201, tag: 'change-requests', reqs,
    summary: 'Suggest a change on a component of a page (code <PAGE>.Cnn); stored in the name of the caller with status new',
    body: { type: 'object', additionalProperties: false, required: ['platform_id', 'page_code', 'kind', 'request'], properties: {
      platform_id: uuid, page_code: { type: 'string', pattern: '^[A-Z]{2,4}-[0-9]{3}$' },
      component_code: { type: 'string', pattern: '^[A-Z]{2,4}-[0-9]{3}\\.C[0-9]{2,3}$' },
      component_kind: { enum: ['table', 'card', 'heading', 'toolbar', 'chart', 'field', 'section', 'component'] },
      component_text: { type: 'string', maxLength: 500 }, dom_path: { type: 'string', maxLength: 1000 }, route: { type: 'string', maxLength: 500 },
      kind: { enum: ['change', 'bug', 'new'] }, request: { type: 'string', minLength: 1, maxLength: 4000 } } },
    handler: async ({ db, claims, body }) => {
      requirePerson(claims, 'Suggesting a change');
      if (!body.request.trim()) throw new HttpError(400, 'invalid_body', 'describe the change');
      return (await db.query(`insert into core.change_request(platform_id, page_code, component_code, component_kind, component_text, dom_path, route, kind, request)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${COLS}`,
      [body.platform_id, body.page_code, body.component_code ?? null, body.component_kind ?? null,
        body.component_text?.replace(/\s+/g, ' ').trim().slice(0, 120) || null, body.dom_path ?? null, body.route ?? null, body.kind, body.request.trim()])).rows[0];
    } }),

  route({ method: 'get', path: '/v1/change-requests', tag: 'change-requests', reqs,
    summary: 'Change requests of a platform, newest first; open = new, triaged, in progress (void ones are never listed)',
    query: { platform_id: uuid, page_code: { type: 'string' }, status: { enum: ['open', 'all', ...CHANGE_STATUSES] } },
    handler: async ({ db, claims, query }) => {
      requirePerson(claims, 'Reading change requests');
      if (!query.platform_id || !/^[0-9a-f-]{36}$/i.test(query.platform_id)) throw new HttpError(400, 'invalid_filter', 'platform_id is required');
      if (query.page_code && !PAGE.test(query.page_code)) throw new HttpError(400, 'invalid_filter', 'page_code must be a page code like TRO-010');
      const st = query.status ?? 'all';
      const statuses = st === 'open' ? OPEN : st === 'all' ? [...CHANGE_STATUSES] : [st];
      if (!statuses.every(s => (CHANGE_STATUSES as readonly string[]).includes(s))) throw new HttpError(400, 'invalid_filter', 'unknown status');
      const items: Row[] = (await db.query(`select ${COLS} from core.change_request where platform_id = $1 and ($2::text is null or page_code = $2)
        and status = any($3) order by created_at desc limit 500`, [query.platform_id, query.page_code ?? null, statuses])).rows;
      return { items };
    } }),

  route<TriageBody>({ method: 'patch', path: '/v1/change-requests/:id', versioned: { table: 'change_request', param: 'id' }, tag: 'change-requests', reqs,
    summary: 'Triage a change request (platform admin): status and/or triage note; audited',
    body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      status: { enum: [...CHANGE_STATUSES] }, triage_note: { type: 'string', maxLength: 2000 } } },
    handler: async ({ db, claims, params, body }) => {
      requirePerson(claims, 'Triaging a change request');
      requireRole(claims, ['platform_admin'], 'Triaging a change request');
      const rows = (await db.query(`update core.change_request set status = coalesce($2, status), triage_note = coalesce($3, triage_note)
        where id = $1 returning ${COLS}`, [params.id, body.status ?? null, body.triage_note ?? null])).rows;
      return rows[0];
    } }),

  route({ method: 'post', path: '/v1/change-requests/:id/void', versioned: { table: 'change_request', param: 'id' }, needsReason: true, tag: 'change-requests', reqs,
    summary: 'Remove a change request from the lists (platform admin): status void with the reason, never a physical delete (DM-03)',
    handler: async ({ db, claims, params }) => {
      requirePerson(claims, 'Removing a change request');
      requireRole(claims, ['platform_admin'], 'Removing a change request');
      return (await db.query(`update core.change_request set status = 'void' where id = $1 returning ${COLS}`, [params.id])).rows[0];
    } }),
];
