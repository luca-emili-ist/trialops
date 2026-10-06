// Part 11 electronic signature service (CMP-02, APP-ID-06). The core computes the hash of the signed content; the
// caller never supplies it. Signatures are append-only (trigger in 0002).
import type { Db } from '../db.ts';
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { requirePerson } from './roles.ts';
import type { Credential, Reauthenticator } from './reauth.ts';
import { contentHash } from './canonical.ts';

export type Meaning = 'author' | 'review' | 'approval' | 'verification' | 'responsibility';

/** Signable targets and the content a signature covers. */
const SIGNABLE: Record<string, (db: Db, id: string) => Promise<unknown | undefined>> = {
  master_protocol_version: async (db, id) => (await db.query('select version_label, usdm from core.master_protocol_version where id = $1', [id])).rows[0],
  arm_appendix_version: async (db, id) => (await db.query('select version_label, usdm from core.arm_appendix_version where id = $1', [id])).rows[0],
  task: async (db, id) => (await db.query('select id, type, outputs from core.task where id = $1', [id])).rows[0],
};
export const SIGNABLE_TABLES = Object.keys(SIGNABLE);

export async function sign(db: Db, claims: Claims, reauth: Reauthenticator | undefined, input: {
  target_table: string; target_id: string; meaning: Meaning; credential: Credential; requested_by_app?: string;
}): Promise<{ id: string; target_hash: string; signed_at: string }> {
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
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, target_hash, signed_at`,
    [claims.sub, name ?? claims.email ?? claims.sub, input.meaning, input.target_table, input.target_id, contentHash(content),
     auth_method, input.requested_by_app ?? null]);
  return r.rows[0];
}
