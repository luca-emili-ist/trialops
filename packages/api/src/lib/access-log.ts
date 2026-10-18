// Data access log (CMP-13): every export of GxP records is recorded by core.log_export() with the SHA-256 of the file
// that leaves the system, in the request transaction, so a failed request leaves no export and no log row.
import type { Db } from '../db.ts';
import { sha256 } from './canonical.ts';

export interface ExportRecord {
  object: string;                      // table or record kind exported, e.g. core.audit_event
  platform_id?: string | null;
  record_id?: string | null;
  filters?: Record<string, unknown>;
  row_count: number;
  format: 'csv' | 'json' | 'pdf' | 'html' | 'zip';
  content: string | Buffer;
  reason?: string | null;
}

export async function logExport(db: Db, e: ExportRecord): Promise<number> {
  const hash = typeof e.content === 'string' ? sha256(e.content) : (await import('node:crypto')).createHash('sha256').update(e.content).digest('hex');
  const r = await db.query('select core.log_export($1, $2, $3, $4, $5, $6, $7, $8) seq',
    [e.object, e.platform_id ?? null, e.record_id ?? null, JSON.stringify(e.filters ?? {}), e.row_count, e.format, hash, e.reason ?? null]);
  return Number(r.rows[0]!.seq);
}
