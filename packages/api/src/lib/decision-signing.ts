// Signature of the Agent Decision Records (AI-08), same scheme as the audit seal (CMP-12, lib/audit-seal.ts): Ed25519,
// key id = first 16 hex of sha256 of the public key (SPKI DER), private key only in the server environment, never in the
// database or the repository. The payload signed is the canonical JSON of the record (sorted keys), stored as is in
// core.agent_decision_record.signed_payload; the database checks its sha256, the sequence and the chain (0025).
//   TRIALOPS_DECISION_SIGNING_KEY   private key, PKCS#8 PEM (or that PEM in base64): records are signed.
//   not set, production             records are written unsigned (signature_status 'unsigned'): monitoring anomaly.
//   not set, development and tests  an ephemeral key is generated per process (marked ephemeral in core.ai_decision_key).
// Production = TRIALOPS_ENV=production, NODE_ENV=production or a Netlify deployment (NETLIFY=true).
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { generateSealKey, keyId } from './audit-seal.ts';
import { canonical, sha256 } from './canonical.ts';
import type { Db } from '../db.ts';

export interface DecisionSigner {
  mode: 'configured' | 'ephemeral' | 'unsigned';
  keyId: string | null;
  publicKeyPem: string | null;
  /** Ed25519 signature (base64) of the payload, or null when no key is configured. */
  sign(payload: string): string | null;
}

export function decisionSigner(privateKeyPem: string | null, mode: DecisionSigner['mode'] = privateKeyPem ? 'configured' : 'unsigned'): DecisionSigner {
  if (!privateKeyPem) return { mode: 'unsigned', keyId: null, publicKeyPem: null, sign: () => null };
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('TRIALOPS_DECISION_SIGNING_KEY must be an Ed25519 private key (AI-08)');
  const pub = createPublicKey(key);
  return { mode, keyId: keyId(pub), publicKeyPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    sign: payload => sign(null, Buffer.from(payload, 'utf8'), key).toString('base64') };
}

export const isProduction = (env: NodeJS.ProcessEnv): boolean =>
  env.TRIALOPS_ENV === 'production' || env.NODE_ENV === 'production' || env.NETLIFY === 'true';

let ephemeral: DecisionSigner | undefined;

export function decisionSignerFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionSigner {
  const raw = env.TRIALOPS_DECISION_SIGNING_KEY?.trim();
  if (raw) return decisionSigner(raw.startsWith('-----BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8'), 'configured');
  if (isProduction(env)) {
    console.warn('TRIALOPS_DECISION_SIGNING_KEY is not set: Agent Decision Records are written UNSIGNED (AI-08 monitoring anomaly)');
    return decisionSigner(null);
  }
  ephemeral ??= decisionSigner(generateSealKey().privateKeyPem, 'ephemeral');
  return ephemeral;
}

/** Fields of the signed payload (version 1). */
export interface DecisionPayload {
  v: 1; id: string; seq: number; prev_record_sha256: string; decided_at: string;
  agent_id: string; tool: string; tool_version_id: string | null; tool_mode: string | null;
  platform_id: string; arm_id: string | null; task_id: string | null; pending_action_id: string | null;
  decision: 'ALLOW' | 'REVIEW' | 'BLOCK'; rule_ids: string[]; rationale: string; inputs_sha256: string;
  ai_request_id: string | null; model: string | null; prompt_id: string | null; prompt_version: string | null;
  actor_sub: string; actor_type: string; key_id: string | null;
}

/** Writes one record: head (sequence, previous hash, server time) → canonical payload → sign → append (checked by the DB). */
export async function appendDecision(db: Db, signer: DecisionSigner, fields: Omit<DecisionPayload, 'v' | 'seq' | 'prev_record_sha256' |
  'decided_at' | 'key_id'>, request: Record<string, unknown>): Promise<{ id: string; seq: number; record_sha256: string; signed: boolean }> {
  const head = (await db.query('select * from core.agent_decision_head()')).rows[0]!;
  const payload: DecisionPayload = { ...fields, v: 1, seq: Number(head.next_seq), prev_record_sha256: head.prev_record_sha256,
    decided_at: head.decided_at, key_id: signer.keyId };
  const text = canonical(payload);
  const hash = sha256(text);
  const signature = signer.sign(text);
  await db.query('select core.agent_decision_append($1, $2, $3, $4, $5, $6)',
    [text, hash, signature, signer.publicKeyPem, JSON.stringify(request), signer.mode === 'ephemeral']);
  return { id: payload.id, seq: payload.seq, record_sha256: hash, signed: signature !== null };
}

export interface DecisionChainRow {
  id: string; seq: number | string; prev_record_sha256: string; record_sha256: string; signed_payload: string;
  signature_ed25519: string | null; signature_status: string; key_id: string | null; decided_at: Date | string;
}
export interface DecisionReport {
  ok: boolean; records: number; signed: number; unsigned: number; ephemeral_key_records: number;
  head_seq: number; head_record_sha256: string; problems: string[];
}

/**
 * Independent verification of the chain: contiguous sequence, each record linked to the previous hash, sha256 of the
 * stored payload equal to record_sha256, payload fields equal to the row, Ed25519 signature valid with a known key.
 * Unsigned records are reported as problems (anomaly) but do not break the chain. publicKeys: key_id → PEM (trusted
 * keys from outside the database when given; otherwise the keys registered in the database).
 */
export function verifyDecisionChain(rows: DecisionChainRow[], publicKeys: Record<string, string>, ephemeralKeys: Set<string> = new Set()): DecisionReport {
  const problems: string[] = [];
  const keys = Object.fromEntries(Object.entries(publicKeys).map(([id, pem]) => [id, createPublicKey(pem)]));
  for (const [id, k] of Object.entries(keys)) if (keyId(k) !== id) problems.push(`public key ${id} does not match its id`);
  let prev = '0'.repeat(64); let expected = 1; let signed = 0; let unsigned = 0; let eph = 0;
  for (const r of rows) {
    const seq = Number(r.seq);
    const at = `record ${seq}`;
    if (seq !== expected) problems.push(`${at}: sequence gap (expected ${expected})`);
    if (r.prev_record_sha256 !== prev) problems.push(`${at}: not linked to the previous record`);
    if (sha256(r.signed_payload) !== r.record_sha256) problems.push(`${at}: record hash does not match the payload`);
    let p: Partial<DecisionPayload> = {};
    try { p = JSON.parse(r.signed_payload) as DecisionPayload; } catch { problems.push(`${at}: payload is not JSON`); }
    if (p.seq !== seq || p.prev_record_sha256 !== r.prev_record_sha256 || p.id !== r.id) problems.push(`${at}: payload differs from the row`);
    if (p.decided_at && new Date(p.decided_at).getTime() !== new Date(r.decided_at).getTime()) problems.push(`${at}: decision time differs from the row`);
    if (r.signature_status === 'unsigned' || !r.signature_ed25519) {
      unsigned++;
      problems.push(`${at}: unsigned (no decision signing key configured)`);
    } else {
      const key = r.key_id ? keys[r.key_id] : undefined;
      if (!key) problems.push(`${at}: unknown key ${r.key_id}`);
      else if (!verify(null, Buffer.from(r.signed_payload, 'utf8'), key, Buffer.from(r.signature_ed25519, 'base64'))) problems.push(`${at}: invalid signature`);
      else signed++;
      if (p.key_id !== r.key_id) problems.push(`${at}: key id differs from the payload`);
      if (r.key_id && ephemeralKeys.has(r.key_id)) eph++;
    }
    prev = r.record_sha256; expected = seq + 1;
  }
  return { ok: problems.length === 0, records: rows.length, signed, unsigned, ephemeral_key_records: eph, head_seq: expected - 1,
    head_record_sha256: prev, problems };
}

/** Reads the chain and the registered keys through the reviewer functions and verifies it. */
export async function verifyDecisions(db: Db, trustedKeys?: Record<string, string>): Promise<DecisionReport & { keys: Record<string, unknown>[] }> {
  const rows = (await db.query('select * from core.agent_decision_chain()')).rows as DecisionChainRow[];
  const keys = (await db.query('select key_id, public_key_pem, ephemeral, registered_by, registered_at from core.ai_decision_keys()')).rows;
  const report = verifyDecisionChain(rows, trustedKeys ?? Object.fromEntries(keys.map(k => [k.key_id, k.public_key_pem])),
    new Set(keys.filter(k => k.ephemeral).map(k => k.key_id as string)));
  return { ...report, keys: keys.map(k => ({ key_id: k.key_id, ephemeral: k.ephemeral, registered_by: k.registered_by, registered_at: k.registered_at })) };
}
