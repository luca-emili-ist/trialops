// Audit ledger seal (CMP-12), command line. The private key never enters the database or the repo.
//   node scripts/audit-seal.mjs keygen <private-key-file>        new Ed25519 key: private PEM to the file (mode 600),
//                                                                public PEM and key id on stdout (publish them)
//   node scripts/audit-seal.mjs seal                              seal the unsealed entries and anchor each seal
//   node scripts/audit-seal.mjs verify                            verify seals, chain and anchor; exit 1 on any problem
// Environment: DATABASE_URL (owner or admin login), TRIALOPS_AUDIT_SEAL_KEY_FILE (private PEM, for seal),
// TRIALOPS_AUDIT_SEAL_PUBKEYS (JSON file { key_id: public PEM }), TRIALOPS_AUDIT_ANCHOR_FILE (JSON Lines anchor).
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { supabaseSsl } from './pg-ssl.mjs';
import { generateSealKey, sealPending, verifySeals, fileAnchor } from '../packages/api/src/lib/audit-seal.ts';

const [cmd, arg] = process.argv.slice(2);
const env = process.env;
if (cmd === 'keygen') {
  if (!arg) { console.error('usage: audit-seal.mjs keygen <private-key-file>'); process.exit(2); }
  const k = generateSealKey();
  writeFileSync(arg, k.privateKeyPem, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ [k.keyId]: k.publicKeyPem }, null, 2));
  process.exit(0);
}
if (cmd !== 'seal' && cmd !== 'verify') { console.error('usage: audit-seal.mjs keygen <file> | seal | verify'); process.exit(2); }
const anchor = env.TRIALOPS_AUDIT_ANCHOR_FILE ? fileAnchor(env.TRIALOPS_AUDIT_ANCHOR_FILE) : undefined;
const c = new pg.Client({ connectionString: env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(env.DATABASE_URL ?? '') ? false : supabaseSsl });
await c.connect();
try {
  if (cmd === 'seal') {
    if (!env.TRIALOPS_AUDIT_SEAL_KEY_FILE) throw new Error('TRIALOPS_AUDIT_SEAL_KEY_FILE is not set');
    if (!anchor) throw new Error('TRIALOPS_AUDIT_ANCHOR_FILE is not set: a seal without an anchor outside the database is not enough (CMP-12)');
    await c.query('begin'); await c.query('set local role audit_sealer');
    const seals = await sealPending(c, { privateKeyPem: readFileSync(env.TRIALOPS_AUDIT_SEAL_KEY_FILE, 'utf8'), anchor });
    await c.query('commit');
    console.log(seals.length ? `sealed blocks ${seals[0].block_no}–${seals.at(-1).block_no} up to seq ${seals.at(-1).to_seq}` : 'nothing to seal');
  } else {
    if (!env.TRIALOPS_AUDIT_SEAL_PUBKEYS) throw new Error('TRIALOPS_AUDIT_SEAL_PUBKEYS is not set');
    const report = await verifySeals(c, { publicKeys: JSON.parse(readFileSync(env.TRIALOPS_AUDIT_SEAL_PUBKEYS, 'utf8')), anchor });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
} finally { await c.end(); }
