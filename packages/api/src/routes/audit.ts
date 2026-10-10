// Audit trail review (CMP-10; 21 CFR 11.10(b)(e), Annex 11 §9, EMA 2023 §6.2, FDA Q&A 2024). QA auditors and platform
// admins consult, filter and export the audit trail and record their reviews, signed with meaning 'review'.
// The database is the enforcement point: core.audit_search() refuses other callers, hides the SAC enclave and redacts
// the subject allocation; core.audit_review completes only with the reviewer's signature (0019).
import { route, uuid, type RawResponse } from '../route.ts';
import type { Db, Row } from '../db.ts';
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { requirePerson, requireRole, type Role } from '../lib/roles.ts';
import { sign, signatureManifests } from '../lib/sign.ts';
import type { Reauthenticator } from '../lib/reauth.ts';

export const AUDIT_REVIEWERS: Role[] = ['qa_auditor', 'platform_admin'];
const reqs = ['CMP-10'];

export interface AuditFilters { table?: string; record_id?: string; actor?: string; from?: string; to?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE = /^[a-z_][a-z0-9_]{0,62}$/;

function requireReviewer(claims: Claims, action: string): void {
  requirePerson(claims, action);
  requireRole(claims, AUDIT_REVIEWERS, action);
}

/** Validates the filters of a query or a review; times are ISO 8601 and interpreted by the server (UTC). */
export function parseFilters(q: Record<string, unknown>): AuditFilters {
  const out: AuditFilters = {};
  const str = (k: string) => { const v = q[k]; return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
  const table = str('table'); const record = str('record_id'); const actor = str('actor'); const from = str('from'); const to = str('to');
  if (table) { if (!TABLE.test(table)) throw new HttpError(400, 'invalid_filter', 'table must be a table name'); out.table = table; }
  if (record) { if (!UUID.test(record)) throw new HttpError(400, 'invalid_filter', 'record_id must be a uuid'); out.record_id = record; }
  if (actor) { if (actor.length > 200) throw new HttpError(400, 'invalid_filter', 'actor too long'); out.actor = actor; }
  for (const [k, v] of [['from', from], ['to', to]] as const) {
    if (!v) continue;
    if (Number.isNaN(Date.parse(v))) throw new HttpError(400, 'invalid_filter', `${k} must be an ISO 8601 date or date-time`);
    out[k] = new Date(v).toISOString();
  }
  return out;
}

function intParam(v: unknown, name: string, min: number, max: number): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'invalid_filter', `${name} must be an integer between ${min} and ${max}`);
  return n;
}

export async function searchAudit(db: Db, f: AuditFilters, opts: { limit: number | null; before?: number | null; minSeq?: number | null; maxSeq?: number | null }): Promise<Row[]> {
  return (await db.query(`select seq::text, occurred_at, actor_sub, actor_type, source_app, table_name, record_id, action, old_row, new_row, reason, hash
    from core.audit_search($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [f.table ?? null, f.record_id ?? null, f.actor ?? null, f.from ?? null, f.to ?? null, opts.limit, opts.before ?? null,
    opts.minSeq ?? null, opts.maxSeq ?? null])).rows.map(r => ({ ...r, seq: Number(r.seq) }));
}

const NOISE = new Set(['updated_at', 'row_version']);
const val = (v: unknown) => v === undefined || v === null ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Human-readable changes of an audit row: "field: old → new" (updates) or "field: value" (inserts). */
export function changedFields(row: { action: string; old_row: Row | null; new_row: Row | null }): string {
  const o = row.old_row ?? {}; const n = row.new_row ?? {};
  if (!row.old_row) return Object.entries(n).filter(([k, v]) => v !== null && !NOISE.has(k)).map(([k, v]) => `${k}: ${val(v)}`).join('; ');
  return [...new Set([...Object.keys(o), ...Object.keys(n)])]
    .filter(k => !NOISE.has(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k]))
    .map(k => `${k}: ${val(o[k])} → ${val(n[k])}`).join('; ');
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // quote always; neutralise spreadsheet formulas (CSV injection) without changing the readable value
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};
export const CSV_HEADER = ['seq', 'occurred_at_utc', 'actor', 'actor_type', 'table', 'record_id', 'action', 'reason', 'changed_fields'];
export function toCsv(rows: Row[]): string {
  const lines = rows.map(r => [r.seq, r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at, r.actor_sub, r.actor_type,
    r.table_name, r.record_id, r.action, r.reason, changedFields(r as never)].map(csvCell).join(','));
  return [CSV_HEADER.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}

const REVIEW_COLS = `id, platform_id, filters, reviewed_from_seq::text, reviewed_to_seq::text, row_count, conclusion, status, signature_id,
  created_by, created_at`;
async function withSignatures(db: Db, rows: Row[]): Promise<Row[]> {
  const m = await signatureManifests(db, rows.map(r => r.signature_id));
  return rows.map(r => ({ ...r, reviewed_from_seq: Number(r.reviewed_from_seq), reviewed_to_seq: Number(r.reviewed_to_seq),
    signature: r.signature_id ? m.get(r.signature_id) ?? null : null }));
}

interface ReviewBody { platform_id: string; filters?: Record<string, unknown>; from_seq: number; to_seq: number; conclusion: string; password?: string }

/** Records a review and signs it (meaning 'review') in one transaction: without a valid signature nothing is kept. */
async function recordReview(db: Db, claims: Claims, reauth: Reauthenticator | undefined, body: ReviewBody): Promise<Row> {
  requireReviewer(claims, 'Recording an audit trail review');
  const filters = parseFilters(body.filters ?? {});
  if (body.from_seq > body.to_seq) throw new HttpError(400, 'invalid_range', 'from_seq must not be greater than to_seq');
  const created = (await db.query(`insert into core.audit_review(platform_id, filters, reviewed_from_seq, reviewed_to_seq, conclusion)
    values ($1, $2, $3, $4, $5) returning id`, [body.platform_id, JSON.stringify(filters), body.from_seq, body.to_seq, body.conclusion.trim()])).rows[0];
  const signature = await sign(db, claims, reauth, { target_table: 'audit_review', target_id: created.id, meaning: 'review',
    credential: { password: body.password } });
  const done = (await db.query(`update core.audit_review set status = 'completed', signature_id = $2 where id = $1 returning ${REVIEW_COLS}`,
    [created.id, signature.id])).rows;
  return (await withSignatures(db, done))[0]!;
}

export const auditRoutes = [
  route({ method: 'get', path: '/v1/audit-events', summary: 'Audit trail review: filter by table, record, actor and period (UTC); newest first',
    tag: 'audit', reqs,
    query: { table: { type: 'string' }, record_id: uuid, actor: { type: 'string' }, from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, before: { type: 'integer' } },
    handler: async ({ db, claims, query }) => {
      requireReviewer(claims, 'Reading the audit trail');
      const f = parseFilters(query);
      const limit = intParam(query.limit, 'limit', 1, 500) ?? 100;
      const items = await searchAudit(db, f, { limit: limit + 1, before: intParam(query.before, 'before', 1, Number.MAX_SAFE_INTEGER) });
      const page: Row[] = items.slice(0, limit).map(r => ({ ...r, changes: changedFields(r as never) }));
      const max = Number((await db.query('select max(seq) m from core.audit_search($1, $2, $3, $4, $5, 1)',
        [f.table ?? null, f.record_id ?? null, f.actor ?? null, f.from ?? null, f.to ?? null])).rows[0]?.m ?? 0);
      return { items: page, next_before: items.length > limit ? page.at(-1)!.seq : null, filters: f, latest_seq: max || null };
    } }),

  route({ method: 'get', path: '/v1/audit-events/export', raw: true, tag: 'audit', reqs,
    summary: 'Readable CSV export of the filtered audit trail (seq, UTC time, actor, table, record, action, reason, old → new)',
    query: { format: { enum: ['csv'] }, table: { type: 'string' }, record_id: uuid, actor: { type: 'string' },
      from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } },
    handler: async ({ db, claims, query }): Promise<RawResponse> => {
      requireReviewer(claims, 'Exporting the audit trail');
      if ((query.format ?? 'csv') !== 'csv') throw new HttpError(400, 'invalid_format', 'only format=csv is available; use the print view for PDF');
      const rows = await searchAudit(db, parseFilters(query), { limit: 10000 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      return { status: 200, body: toCsv(rows), headers: { 'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="trialops-audit-trail-${stamp}.csv"`, 'x-row-count': String(rows.length) } };
    } }),

  route<ReviewBody>({ method: 'post', path: '/v1/audit-reviews', status: 201, needsReason: true, tag: 'audit', reqs: ['CMP-10', 'CMP-11'],
    summary: 'Record an audit trail review over a seq range with its conclusion, signed by the reviewer (meaning review)',
    body: { type: 'object', additionalProperties: false, required: ['platform_id', 'from_seq', 'to_seq', 'conclusion'], properties: {
      platform_id: uuid, from_seq: { type: 'integer', minimum: 1 }, to_seq: { type: 'integer', minimum: 1 },
      conclusion: { type: 'string', minLength: 1, maxLength: 4000 }, password: { type: 'string' },
      filters: { type: 'object', additionalProperties: false, properties: { table: { type: 'string' }, record_id: { type: 'string' },
        actor: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } } } },
    handler: async ({ db, claims, body, services }) => recordReview(db, claims, services.reauth, body) }),

  route({ method: 'get', path: '/v1/audit-reviews', summary: 'Recorded audit trail reviews with their signature manifestation', tag: 'audit', reqs,
    query: { platform_id: uuid },
    handler: async ({ db, claims, query }) => {
      requireReviewer(claims, 'Reading audit trail reviews');
      const rows = (await db.query(`select ${REVIEW_COLS} from core.audit_review where ($1::uuid is null or platform_id = $1) and status <> 'void'
        order by created_at desc limit 200`, [query.platform_id && UUID.test(query.platform_id) ? query.platform_id : null])).rows;
      return { items: await withSignatures(db, rows) };
    } }),
];
