// Certified copies (CMP-14): a record or a whole trial with data, audit trail, signatures and hashes, in JSON (open
// format) or, for a record, readable HTML (printable to PDF). For QA auditors and platform admins, who already review
// the audit trail (CMP-10); every copy is an export and is recorded in the access log with its hash (CMP-13).
import { route, type RawResponse } from '../route.ts';
import { HttpError } from '../errors.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { logExport } from '../lib/access-log.ts';
import { recordCopy, recordCopyHtml, trialCopy } from '../lib/certified-copy.ts';
import { AUDIT_REVIEWERS } from './audit.ts';

const reqs = ['CMP-14', 'CMP-13'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export const certifiedCopyRoutes = [
  route({ method: 'get', path: '/v1/certified-copies/:table/:id', raw: true, tag: 'audit', reqs,
    summary: 'Certified copy of one record: data, full audit trail, signature manifestation, SHA-256 of each section and of the copy',
    query: { format: { enum: ['json', 'html'] } },
    handler: async ({ db, claims, params, query }): Promise<RawResponse> => {
      requirePerson(claims, 'Making a certified copy');
      requireRole(claims, AUDIT_REVIEWERS, 'Making a certified copy');
      if (!UUID.test(params.id!)) throw new HttpError(400, 'invalid_id', 'id must be a uuid');
      const format = query.format ?? 'json';
      if (format !== 'json' && format !== 'html') throw new HttpError(400, 'invalid_format', 'format must be json or html');
      const { copy, rows, platform_id } = await recordCopy(db, claims, params.table!, params.id!);
      const body = format === 'html' ? recordCopyHtml(copy) : JSON.stringify(copy, null, 2) + '\n';
      const seq = await logExport(db, { object: `certified_copy:${params.table}`, platform_id, record_id: params.id, row_count: rows, format, content: body });
      return { status: 200, body, headers: {
        'content-type': format === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="trialops-certified-copy-${params.table}-${params.id}-${stamp()}.${format}"`,
        'x-content-sha256': copy.content_sha256, 'x-access-log-seq': String(seq) } };
    } }),

  route({ method: 'get', path: '/v1/platforms/:id/certified-copy', raw: true, tag: 'audit', reqs,
    summary: 'Certified copy of a whole trial (platform): every record visible to the caller, audit trail, signatures, hashes; JSON',
    handler: async ({ db, claims, params }): Promise<RawResponse> => {
      requirePerson(claims, 'Making a certified copy');
      requireRole(claims, AUDIT_REVIEWERS, 'Making a certified copy');
      if (!UUID.test(params.id!)) throw new HttpError(400, 'invalid_id', 'id must be a uuid');
      const { copy, rows } = await trialCopy(db, claims, params.id!);
      const body = JSON.stringify(copy, null, 2) + '\n';
      const seq = await logExport(db, { object: 'certified_copy:trial', platform_id: params.id, record_id: params.id, row_count: rows, format: 'json', content: body });
      return { status: 200, body, headers: { 'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="trialops-certified-copy-trial-${copy.certified_copy.scope.platform_code}-${stamp()}.json"`,
        'x-content-sha256': copy.content_sha256, 'x-access-log-seq': String(seq) } };
    } }),
];
