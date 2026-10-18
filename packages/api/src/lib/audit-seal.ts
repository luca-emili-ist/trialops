// Audit ledger seal (CMP-12): blocks of core.audit_event signed with Ed25519 outside the database, copied to an anchor
// outside the database, and verifiable by anyone holding the public key. The private key lives only in the sealer's
// environment (never in the database or the repo); key_id is the SHA-256 of the public key (SPKI DER), first 16 hex.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/** Minimal client: a pg Client or PoolClient inside a transaction, as the role audit_sealer (seal) or an owner (verify). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows of pg, typed where read
export interface SealDb { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, any>[] }> }

export interface Seal {
  block_no: number; from_seq: number; to_seq: number; head_hash: string; prev_seal_hash: string;
  key_id: string; signature: string; seal_hash: string;
}

/** Where copies of the seals are kept outside the database. */
export interface Anchor {
  name: string;
  put(seal: Seal): Promise<string>;               // returns the reference recorded in core.audit_anchor
  list(): Promise<Seal[]>;
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function keyId(publicKey: KeyObject | string): string {
  const k = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return sha256(k.export({ type: 'spki', format: 'der' })).slice(0, 16);
}

export function generateSealKey(): { privateKeyPem: string; publicKeyPem: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId: keyId(publicKey) };
}

/** Same text as core.audit_seal_payload(): canonical JSON with sorted keys. */
export const sealPayload = (s: Pick<Seal, 'block_no' | 'from_seq' | 'to_seq' | 'head_hash' | 'prev_seal_hash'>) =>
  `{"block_no":${s.block_no},"from_seq":${s.from_seq},"head_hash":"${s.head_hash}","prev_seal_hash":"${s.prev_seal_hash}","to_seq":${s.to_seq},"v":1}`;

export const sealHash = (s: Pick<Seal, 'block_no' | 'from_seq' | 'to_seq' | 'head_hash' | 'prev_seal_hash' | 'signature'>) =>
  sha256(`${sealPayload(s)}.${s.signature}`);

/** Append-only JSON Lines file: the simplest anchor (local, tests, or a WORM-mounted volume). */
export function fileAnchor(path: string): Anchor {
  return {
    name: 'file',
    async put(seal) { appendFileSync(path, JSON.stringify(seal) + '\n'); return `${path}#block=${seal.block_no}`; },
    async list() {
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Seal);
    },
  };
}

/** Seals every unsealed entry, in blocks of at most maxPerBlock, and anchors each seal. Returns the new seals. */
export async function sealPending(db: SealDb, opts: { privateKeyPem: string; anchor?: Anchor; maxPerBlock?: number; maxBlocks?: number }): Promise<Seal[]> {
  const key = createPrivateKey(opts.privateKeyPem);
  const kid = keyId(createPublicKey(key));
  const out: Seal[] = [];
  for (let i = 0; i < (opts.maxBlocks ?? 1000); i++) {
    const next = (await db.query('select * from core.audit_seal_next($1)', [opts.maxPerBlock ?? 1000])).rows[0];
    if (!next) break;
    const base = { block_no: Number(next.block_no), from_seq: Number(next.from_seq), to_seq: Number(next.to_seq),
      head_hash: next.head_hash as string, prev_seal_hash: next.prev_seal_hash as string };
    if (sealPayload(base) !== next.payload) throw new Error('seal payload differs between database and sealer');
    const signature = sign(null, Buffer.from(next.payload, 'utf8'), key).toString('base64');
    const seal_hash = (await db.query('select core.audit_seal_append($1, $2, $3, $4, $5, $6) h',
      [base.block_no, base.from_seq, base.to_seq, base.head_hash, kid, signature])).rows[0]!.h as string;
    const seal: Seal = { ...base, key_id: kid, signature, seal_hash };
    if (opts.anchor) await db.query('select core.audit_anchor_append($1, $2, $3)', [seal.block_no, opts.anchor.name, await opts.anchor.put(seal)]);
    out.push(seal);
  }
  return out;
}

export interface SealReport { ok: boolean; blocks: number; sealed_to_seq: number; unsealed_entries: number; problems: string[] }

/**
 * Independent verification: every seal signed by a known key, chained to the previous one, contiguous, with the head
 * hash still equal to the ledger; the ledger chain itself (core.audit_verify); and every seal present, identical, in
 * the anchor. Needs read access to core.audit_event (owner or an admin role).
 */
export async function verifySeals(db: SealDb, opts: { publicKeys: Record<string, string>; anchor?: Anchor }): Promise<SealReport> {
  const problems: string[] = [];
  const seals = (await db.query('select * from core.audit_seals()')).rows.map(r => ({ ...r, block_no: Number(r.block_no),
    from_seq: Number(r.from_seq), to_seq: Number(r.to_seq) })) as (Seal & { anchors: unknown[] })[];
  const keys = Object.fromEntries(Object.entries(opts.publicKeys).map(([id, pem]) => [id, createPublicKey(pem)]));
  for (const [id, k] of Object.entries(keys)) if (keyId(k) !== id) problems.push(`public key ${id} does not match its id`);
  const broken = (await db.query('select core.audit_verify() b')).rows[0]!.b;
  if (broken !== null) problems.push(`audit ledger chain broken at seq ${broken}`);
  let prevHash = '0'.repeat(64); let prevTo = 0;
  for (const s of seals) {
    const where = `block ${s.block_no}`;
    if (s.prev_seal_hash !== prevHash) problems.push(`${where}: not linked to the previous seal`);
    const first = (await db.query('select min(seq) m from core.audit_event where seq > $1', [prevTo])).rows[0]!.m;
    if (Number(first) !== s.from_seq) problems.push(`${where}: gap or overlap before seq ${s.from_seq}`);
    const head = (await db.query('select hash from core.audit_event where seq = $1', [s.to_seq])).rows[0]?.hash;
    if (head !== s.head_hash) problems.push(`${where}: head hash differs from the ledger at seq ${s.to_seq}`);
    const key = keys[s.key_id];
    if (!key) problems.push(`${where}: unknown key ${s.key_id}`);
    else if (!verify(null, Buffer.from(sealPayload(s), 'utf8'), key, Buffer.from(s.signature, 'base64'))) problems.push(`${where}: invalid signature`);
    if (sealHash(s) !== s.seal_hash) problems.push(`${where}: seal hash does not match its content`);
    prevHash = s.seal_hash; prevTo = s.to_seq;
  }
  if (opts.anchor) {
    const copies = new Map((await opts.anchor.list()).map(a => [a.block_no, a]));
    for (const s of seals) {
      const a = copies.get(s.block_no);
      if (!a) problems.push(`block ${s.block_no}: missing from anchor ${opts.anchor.name}`);
      else if (a.seal_hash !== s.seal_hash || a.signature !== s.signature || a.head_hash !== s.head_hash || a.to_seq !== s.to_seq) {
        problems.push(`block ${s.block_no}: anchor copy differs from the database`);
      }
    }
  }
  const unsealed = Number((await db.query('select count(*) n from core.audit_event where seq > $1', [prevTo])).rows[0]!.n);
  return { ok: problems.length === 0, blocks: seals.length, sealed_to_seq: prevTo, unsealed_entries: unsealed, problems };
}
