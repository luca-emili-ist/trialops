// Part 11 electronic signature service (CMP-02, APP-ID-06). The core computes the hash of the signed content; the
// caller never supplies it. Signatures are append-only (trigger in 0002).
import type { Db } from '../db.ts';
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { requirePerson } from './roles.ts';
import type { Credential, Reauthenticator } from './reauth.ts';
import { contentHash } from './canonical.ts';

export type Meaning = 'author' | 'review' | 'approval' | 'verification' | 'responsibility';

/** What a signature shows wherever it is displayed, printed or exported (CMP-11, Part 11 §11.50): printed name, meaning,
 * UTC date and time (ISO 8601, from the database clock) and reason; plus the authentication used. */
export interface SignatureManifest {
  id: string; signer_sub: string; signer_name: string; meaning: Meaning; signed_at: string; reason: string | null; auth_method: string;
  target_table: string; target_id: string;
}
export const MANIFEST_COLS = 'id, signer_sub, signer_name, meaning, signed_at, reason, auth_method, target_table, target_id';

/** Manifestations of the given signatures, keyed by id (missing ids are skipped). */
export async function signatureManifests(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, SignatureManifest>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const rows = (await db.query(`select ${MANIFEST_COLS} from core.signature where id = any($1::uuid[])`, [want])).rows as SignatureManifest[];
  return new Map(rows.map(r => [r.id, r]));
}

/** Signable targets and the content a signature covers. */
const SIGNABLE: Record<string, (db: Db, id: string) => Promise<unknown | undefined>> = {
  master_protocol_version: async (db, id) => (await db.query('select version_label, usdm from core.master_protocol_version where id = $1', [id])).rows[0],
  arm_appendix_version: async (db, id) => (await db.query('select version_label, usdm from core.arm_appendix_version where id = $1', [id])).rows[0],
  task: async (db, id) => (await db.query('select id, type, outputs from core.task where id = $1', [id])).rows[0],
  audit_review: async (db, id) => (await db.query(`select id, platform_id, filters, reviewed_from_seq, reviewed_to_seq, row_count, conclusion, created_by
    from core.audit_review where id = $1 and status = 'open'`, [id])).rows[0],
};
export const SIGNABLE_TABLES = Object.keys(SIGNABLE);

export async function sign(db: Db, claims: Claims, reauth: Reauthenticator | undefined, input: {
  target_table: string; target_id: string; meaning: Meaning; credential: Credential; requested_by_app?: string;
}): Promise<SignatureManifest & { target_hash: string }> {
  requirePerson(claims, 'Signing');
  if (!reauth) throw new HttpError(501, 'signing_unavailable', 'no re-authentication provider configured');
  const load = SIGNABLE[input.target_table];
  if (!load) throw new HttpError(422, 'not_signable', `${input.target_table} cannot be signed`);
  const content = await load(db, input.target_id);
  if (content === undefined) throw new HttpError(404, 'not_found', 'signature target not found');
  const auth_method = await reauth.reauth(claims, input.credential);
  const name = claims.person_id
    ? (await db.query('select full_name from core.person where id = $1', [claims.person_id])).rows[0]?.full_name
    : undefined;
  const r = await db.query(`insert into core.signature(signer_sub, signer_name, meaning, target_table, target_id, target_hash, auth_method, requested_by_app)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${MANIFEST_COLS}, target_hash`,
    [claims.sub, name ?? claims.email ?? claims.sub, input.meaning, input.target_table, input.target_id, contentHash(content),
     auth_method, input.requested_by_app ?? null]);
  return r.rows[0];
}
