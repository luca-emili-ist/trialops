// Access log report (CMP-13): unblinded reads of the SAC enclave and exports of GxP records, for QA auditors and
// platform admins. core.access_log_search() is the enforcement point (0021); exporting the report is itself logged.
import { route, uuid, type RawResponse } from '../route.ts';
import type { Db, Row } from '../db.ts';
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { logExport } from '../lib/access-log.ts';
import { AUDIT_REVIEWERS, csvCell } from './audit.ts';

const reqs = ['CMP-13'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['unblinded_read', 'export'];

interface Filters { platform_id: string | null; kind: string | null; from: string | null; to: string | null }

function parse(q: Record<string, string | undefined>): Filters {
  const f: Filters = { platform_id: null, kind: null, from: null, to: null };
  if (q.platform_id) { if (!UUID.test(q.platform_id)) throw new HttpError(400, 'invalid_filter', 'platform_id must be a uuid'); f.platform_id = q.platform_id; }
  if (q.kind) { if (!KINDS.includes(q.kind)) throw new HttpError(400, 'invalid_filter', `kind must be one of ${KINDS.join(', ')}`); f.kind = q.kind; }
  for (const k of ['from', 'to'] as const) {
    const v = q[k];
    if (!v) continue;
    if (Number.isNaN(Date.parse(v))) throw new HttpError(400, 'invalid_filter', `${k} must be an ISO 8601 date or date-time`);
    f[k] = new Date(v).toISOString();
  }
  return f;
}

function requireReviewer(claims: Claims, action: string): void {
  requirePerson(claims, action);
  requireRole(claims, AUDIT_REVIEWERS, action);
}

async function search(db: Db, f: Filters, limit: number): Promise<Row[]> {
  return (await db.query(`select seq::text, occurred_at, actor_sub, actor_type, actor_email, kind, object, platform_id, record_id, filters,
      row_count, format, content_sha256, reason from core.access_log_search($1, $2, $3, $4, $5)`,
  [f.platform_id, f.kind, f.from, f.to, limit])).rows.map(r => ({ ...r, seq: Number(r.seq) }));
}

export const ACCESS_CSV_HEADER = ['seq', 'occurred_at_utc', 'actor', 'actor_type', 'email', 'kind', 'object', 'platform_id', 'record_id',
  'filters', 'row_count', 'format', 'sha256', 'reason'];
const toCsv = (rows: Row[]) => [ACCESS_CSV_HEADER.map(csvCell).join(','), ...rows.map(r => [r.seq,
  r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at, r.actor_sub, r.actor_type, r.actor_email, r.kind, r.object,
  r.platform_id, r.record_id, JSON.stringify(r.filters ?? {}), r.row_count, r.format, r.content_sha256, r.reason].map(csvCell).join(','))]
  .join('\r\n') + '\r\n';

const query = { platform_id: uuid, kind: { enum: KINDS }, from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } };

export const accessLogRoutes = [
  route({ method: 'get', path: '/v1/access-log', tag: 'audit', reqs, query,
    summary: 'Unblinded reads and exports (who, when UTC, what, how many rows, file hash, reason); QA auditors and platform admins',
    handler: async ({ db, claims, query: q }) => {
      requireReviewer(claims, 'Reading the access log');
      const f = parse(q);
      return { items: await search(db, f, 500), filters: f };
    } }),

  route({ method: 'get', path: '/v1/access-log/export', raw: true, tag: 'audit', reqs, query,
    summary: 'CSV export of the access log; the export is itself recorded in the log',
    handler: async ({ db, claims, query: q }): Promise<RawResponse> => {
      requireReviewer(claims, 'Exporting the access log');
      const f = parse(q);
      const rows = await search(db, f, 10000);
      const body = toCsv(rows);
      const seq = await logExport(db, { object: 'core.data_access_log', platform_id: f.platform_id, filters: { ...f }, row_count: rows.length,
        format: 'csv', content: body });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      return { status: 200, body, headers: { 'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="trialops-access-log-${stamp}.csv"`, 'x-row-count': String(rows.length),
        'x-access-log-seq': String(seq) } };
    } }),
];
