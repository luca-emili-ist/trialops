// CMP-12 audit seal: Ed25519 blocks signed outside the database, anchored outside it, verifiable with the public key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type Api } from './_helpers.ts';
import { generateSealKey, sealPending, verifySeals, fileAnchor, sealPayload } from '../src/lib/audit-seal.ts';

let api: Api;
before(async () => { api = await startApi({}); });
after(async () => api.close());

const key = generateSealKey();
const other = generateSealKey();
const keys = { [key.keyId]: key.publicKeyPem };
const asSealer = async <T>(fn: () => Promise<T>): Promise<T> => {
  await api.admin.query('begin'); await api.admin.query('set local role audit_sealer');
  try { const r = await fn(); await api.admin.query('commit'); return r; } catch (e) { await api.admin.query('rollback'); throw e; }
};
const expectError = async (sql: string, params: unknown[], re: RegExp) => {
  await api.admin.query('begin');
  try { await api.admin.query(sql, params); assert.fail('expected an error'); } catch (e) { assert.match((e as Error).message, re); }
  finally { await api.admin.query('rollback'); }
};

test('[CMP-12] the sealer signs every block of the ledger and anchors it outside the database; the verifier accepts it', async () => {
  const anchorFile = join(mkdtempSync(join(tmpdir(), 'seal-')), 'anchor.jsonl');
  const seals = await asSealer(() => sealPending(api.admin, { privateKeyPem: key.privateKeyPem, anchor: fileAnchor(anchorFile), maxPerBlock: 200 }));
  assert.ok(seals.length >= 2, 'several blocks');
  assert.equal(seals[0]!.from_seq, 1);
  assert.equal(seals[0]!.prev_seal_hash, '0'.repeat(64));
  assert.equal(seals[1]!.prev_seal_hash, seals[0]!.seal_hash);
  assert.equal(readFileSync(anchorFile, 'utf8').trim().split('\n').length, seals.length);
  const report = await verifySeals(api.admin, { publicKeys: keys, anchor: fileAnchor(anchorFile) });
  assert.deepEqual(report.problems, []);
  assert.equal(report.unsealed_entries, 0);
  // new entries are sealed in the next block, linked to the last one
  await api.admin.query("insert into core.audit_event(actor_sub, actor_type, table_name, action) values ('system:test', 'system', 'platform', 'EXTERNAL')");
  const more = await asSealer(() => sealPending(api.admin, { privateKeyPem: key.privateKeyPem, anchor: fileAnchor(anchorFile) }));
  assert.equal(more.length, 1);
  assert.equal(more[0]!.prev_seal_hash, seals.at(-1)!.seal_hash);
  assert.ok((await verifySeals(api.admin, { publicKeys: keys, anchor: fileAnchor(anchorFile) })).ok);

  // a copy altered or missing in the anchor is detected
  const lines = readFileSync(anchorFile, 'utf8').trim().split('\n');
  writeFileSync(anchorFile, [JSON.stringify({ ...JSON.parse(lines[0]!), signature: 'AAAA' }), ...lines.slice(2)].join('\n') + '\n');
  const bad = await verifySeals(api.admin, { publicKeys: keys, anchor: fileAnchor(anchorFile) });
  assert.ok(bad.problems.some(p => /block 1: anchor copy differs/.test(p)));
  assert.ok(bad.problems.some(p => /block 2: missing from anchor/.test(p)));
});

test('[CMP-12] the database refuses seals out of order, not starting at the first unsealed entry or with a wrong head hash', async () => {
  const next = (await api.admin.query('select * from core.audit_seal_next(10)')).rows[0];
  if (!next) await api.admin.query("insert into core.audit_event(actor_sub, actor_type, table_name, action) values ('system:test', 'system', 'platform', 'EXTERNAL')");
  const n = (await api.admin.query('select * from core.audit_seal_next(10)')).rows[0];
  const args = [Number(n.block_no), Number(n.from_seq), Number(n.to_seq), n.head_hash, key.keyId, 'sig'];
  await expectError('select core.audit_seal_append($1, $2, $3, $4, $5, $6)', [args[0] as number + 1, ...args.slice(1)], /out of order/);
  await expectError('select core.audit_seal_append($1, $2, $3, $4, $5, $6)', [args[0], (args[1] as number) + 1, ...args.slice(2)], /first unsealed entry/);
  await expectError('select core.audit_seal_append($1, $2, $3, $4, $5, $6)', [...args.slice(0, 3), 'f'.repeat(64), ...args.slice(4)], /head hash/);
  await expectError('update core.audit_seal set signature = $1', ['x'], /append-only/);
  await expectError('delete from core.audit_anchor', [], /append-only/);
});

test('[CMP-12] a seal signed with an unknown key or a forged signature fails verification', async () => {
  await api.admin.query("insert into core.audit_event(actor_sub, actor_type, table_name, action) values ('system:test', 'system', 'platform', 'EXTERNAL')");
  const forged = await asSealer(() => sealPending(api.admin, { privateKeyPem: other.privateKeyPem, maxBlocks: 1 }));
  const r1 = await verifySeals(api.admin, { publicKeys: keys });
  assert.ok(r1.problems.some(p => p === `block ${forged[0]!.block_no}: unknown key ${other.keyId}`));
  // the forger publishes its own key under the real key id: the signature does not verify
  const r2 = await verifySeals(api.admin, { publicKeys: { ...keys, [other.keyId]: key.publicKeyPem } });
  assert.ok(r2.problems.some(p => /does not match its id/.test(p)));
  assert.match(sealPayload(forged[0]!), /^\{"block_no":\d+,"from_seq":\d+,"head_hash":"[0-9a-f]{64}","prev_seal_hash":"[0-9a-f]{64}","to_seq":\d+,"v":1\}$/);
});

test('[CMP-12] the sealer role can only read the next block and append; it cannot read or write the ledger directly', async () => {
  for (const sql of ['select * from core.audit_event limit 1', "insert into core.audit_seal(block_no) values (999)", 'select * from core.ddl_event limit 1']) {
    await api.admin.query('begin'); await api.admin.query('set local role audit_sealer');
    try { await api.admin.query(sql); assert.fail(`audit_sealer ran: ${sql}`); } catch (e) { assert.match((e as Error).message, /permission denied/); }
    finally { await api.admin.query('rollback'); }
  }
});
