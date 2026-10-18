// Write controls of the Platform API (0024):
//   APP-DT-02 idempotent writes (Idempotency-Key) and optimistic concurrency (If-Match on row_version, ETag on reads);
//   APP-DT-05 provenance of app-written data (X-Source-Record-Id, X-Source-Version, X-Transformation-Id).
// The database keeps the replay cache (core.idempotency_lookup/store) and stamps provenance (core.stamp_provenance).
import type { Db } from '../db.ts';
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { canonical, sha256 } from './canonical.ts';

/** UUID or 8–128 characters among letters, digits and _ . : - (same check as the table). */
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

export const isApp = (claims: Claims): boolean => claims.actor_type === 'app';

/** The Idempotency-Key of a write: required for apps, optional for people and agents. */
export function idempotencyKey(header: string | undefined, claims: Claims): string | undefined {
  const key = header?.trim();
  if (!key) {
    if (isApp(claims)) throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key header required for writes by apps (APP-DT-02)');
    return undefined;
  }
  if (!KEY.test(key)) throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key must be a UUID or 8-128 characters [A-Za-z0-9_.:-] (APP-DT-02)');
  return key;
}

/** What makes two requests "the same": method, URL (path and query), change reason and canonical JSON body. */
export function requestHash(method: string, url: string, reason: string | undefined, body: unknown): string {
  return sha256(canonical({ method: method.toUpperCase(), url, reason: reason ?? null, body: body ?? null }));
}

export interface StoredResponse { status: number; headers: Record<string, string>; body: unknown; text: string | null }

export async function lookupResponse(db: Db, key: string, hash: string): Promise<StoredResponse | undefined> {
  const r = (await db.query('select * from core.idempotency_lookup($1)', [key])).rows[0];
  if (!r) return undefined;
  if (r.request_sha256 !== hash) {
    throw new HttpError(422, 'idempotency_key_reused',
      `Idempotency-Key already used for a different request (${r.method} ${r.path}) (APP-DT-02)`);
  }
  return { status: r.response_status, headers: r.response_headers ?? {}, body: r.response_body, text: r.response_text };
}

export async function storeResponse(db: Db, key: string, method: string, path: string, hash: string, res: StoredResponse): Promise<void> {
  await db.query('select core.idempotency_store($1, $2, $3, $4, $5, $6, $7, $8)',
    [key, method, path, hash, res.status, JSON.stringify(res.headers), res.text === null ? JSON.stringify(res.body ?? null) : null, res.text]);
}

/** A concurrent request with the same key committed first (primary key of core.idempotency_record). */
export const isKeyRace = (e: unknown): boolean =>
  (e as { code?: string; constraint?: string })?.code === '23505' && (e as { constraint?: string }).constraint === 'idempotency_record_pkey';

// ===== optimistic concurrency =====

/** A versioned record addressed by a route: core.<table> with the id in the path parameter <param>. */
export interface VersionedRecord { table: string; param: string }

/** Parses If-Match: "3", W/"3", 3 or * (any current version). Several values: any may match. */
export function parseIfMatch(header: string | undefined): (number | '*')[] | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  const out: (number | '*')[] = [];
  for (const part of raw.split(',').map(s => s.trim())) {
    if (part === '*') { out.push('*'); continue; }
    const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(part);
    if (!m) throw new HttpError(400, 'invalid_if_match', 'If-Match must be the row_version as an entity tag, e.g. "3" (APP-DT-02)');
    out.push(Number(m[1]));
  }
  return out;
}

export const etagOf = (version: number): string => `"${version}"`;

const TABLE = /^[a-z_]+$/;
export async function currentVersion(db: Db, rec: VersionedRecord, id: string | undefined, lock: boolean): Promise<number | undefined> {
  if (!id || !TABLE.test(rec.table)) return undefined;
  // serialises conditional writes on the same record, so two writers with the same If-Match cannot both pass
  if (lock) await db.query('select pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['trialops.if_match', `${rec.table}:${id}`]);
  const r = (await db.query(`select row_version from core.${rec.table} where id = $1::uuid`, [id])).rows[0];
  return r ? Number(r.row_version) : undefined;
}

/** 412 when the record changed since the version the caller read. A missing record is left to the handler (404). */
export function checkIfMatch(expected: (number | '*')[], current: number | undefined): void {
  if (current === undefined) return;
  if (expected.some(v => v === '*' || v === current)) return;
  throw new HttpError(412, 'precondition_failed',
    `the record changed: current version ${etagOf(current)}, If-Match ${expected.map(v => (v === '*' ? '*' : etagOf(v))).join(', ')} (APP-DT-02)`);
}

// ===== provenance =====

export interface Provenance { source_record_id: string; source_version: string; transformation_id: string }
const printable = (v: string) => v.length >= 1 && v.length <= 200 && [...v].every(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127);

/** Provenance an app must supply with every write (APP-DT-05); source_app comes from its token. */
export function appProvenance(headers: Record<string, string | undefined>, claims: Claims): Provenance {
  if (!claims.app_id) throw new HttpError(403, 'app_id_required', 'app token without app_id (APP-DT-05)');
  const get = (h: string) => (typeof headers[h] === 'string' ? headers[h]!.trim() : '');
  const p = { source_record_id: get('x-source-record-id'), source_version: get('x-source-version'), transformation_id: get('x-transformation-id') };
  const missing = Object.entries(p).filter(([, v]) => !printable(v)).map(([k]) => k);
  if (missing.length) {
    throw new HttpError(422, 'provenance_required', `app writes need provenance headers X-Source-Record-Id, X-Source-Version and ` +
      `X-Transformation-Id (1-200 printable characters); missing or invalid: ${missing.join(', ')} (APP-DT-05)`);
  }
  return p;
}
