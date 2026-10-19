// Agent Decision Records (AI-08), command line. Same key scheme as the audit seal (CMP-12): Ed25519, key id = first 16
// hex of sha256 of the public key. The private key never enters the database or the repo.
//   node scripts/decision-verify.mjs keygen <private-key-file>   new Ed25519 key: private PEM to the file (mode 600), public
//                                                                PEM and key id on stdout. Put the private PEM (or its
//                                                                base64) in TRIALOPS_DECISION_SIGNING_KEY of the server.
//   node scripts/decision-verify.mjs verify                       verify the whole chain: sequence, links, payload hashes,
//                                                                signatures; unsigned records are reported; exit 1 on any problem
// Environment: DATABASE_URL (owner or admin login, reads core.agent_decision_record directly);
// TRIALOPS_DECISION_PUBKEYS (optional JSON file { key_id: public PEM }: trusted keys kept outside the database; without
// it the keys registered in core.ai_decision_key are used, which proves integrity but not independence).
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { supabaseSsl } from './pg-ssl.mjs';
import { generateSealKey } from '../packages/api/src/lib/audit-seal.ts';
import { verifyDecisionChain } from '../packages/api/src/lib/decision-signing.ts';

const [cmd, arg] = process.argv.slice(2);
const env = process.env;
if (cmd === 'keygen') {
  if (!arg) { console.error('usage: decision-verify.mjs keygen <private-key-file>'); process.exit(2); }
  const k = generateSealKey();
  writeFileSync(arg, k.privateKeyPem, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ [k.keyId]: k.publicKeyPem }, null, 2));
  process.exit(0);
}
if (cmd !== 'verify') { console.error('usage: decision-verify.mjs keygen <file> | verify'); process.exit(2); }
const c = new pg.Client({ connectionString: env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(env.DATABASE_URL ?? '') ? false : supabaseSsl });
await c.connect();
try {
  const rows = (await c.query(`select id, seq, prev_record_sha256, record_sha256, signed_payload, signature_ed25519, signature_status, key_id, decided_at
    from core.agent_decision_record where seq is not null order by seq`)).rows;
  const registered = (await c.query('select key_id, public_key_pem, ephemeral from core.ai_decision_key')).rows;
  const keys = env.TRIALOPS_DECISION_PUBKEYS ? JSON.parse(readFileSync(env.TRIALOPS_DECISION_PUBKEYS, 'utf8'))
    : Object.fromEntries(registered.map(k => [k.key_id, k.public_key_pem]));
  const legacy = Number((await c.query('select count(*) n from core.agent_decision_record where seq is null')).rows[0].n);
  const report = verifyDecisionChain(rows, keys, new Set(registered.filter(k => k.ephemeral).map(k => k.key_id)));
  if (legacy) report.problems.push(`${legacy} record(s) written before 0025 without chain or signature`);
  console.log(JSON.stringify({ ...report, ok: report.problems.length === 0, trusted_keys: env.TRIALOPS_DECISION_PUBKEYS ? 'file' : 'database' }, null, 2));
  process.exitCode = report.problems.length === 0 ? 0 : 1;
} finally { await c.end(); }
