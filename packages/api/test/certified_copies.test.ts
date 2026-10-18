// CMP-14 certified copies: a record or a whole trial with data, audit trail, signatures and hashes, verifiable by anyone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startApi, platformId, type Api } from './_helpers.ts';
import { canonical } from '../src/lib/canonical.ts';

let api: Api; let plat: string; let mpId: string; let subjectId: string;
before(async () => {
  api = await startApi({});
  plat = await platformId(api.admin);
  mpId = (await api.admin.query("select id from core.master_protocol_version where platform_id = $1 and status = 'approved' limit 1", [plat])).rows[0].id;
  subjectId = (await api.admin.query('select id from core.subject where platform_id = $1 and arm_id is not null limit 1', [plat])).rows[0].id;
});
after(async () => api.close());

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const get = async (path: string, who: string) => fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${await api.tokenFor(who)}` } });

/** Recomputes every hash of a copy the way an inspector would, from the file alone. */
function verify(copy: any): void {
  const { content_sha256, ...body } = copy;
  assert.equal(sha(canonical(body)), content_sha256, 'copy hash');
  for (const [k, h] of Object.entries(copy.certified_copy.section_sha256)) assert.equal(sha(canonical(copy[k])), h, `section ${k}`);
}

test('[CMP-14] a record copy carries the data, the full audit trail, the signature manifestation and verifiable hashes', async () => {
  const res = await get(`/v1/certified-copies/master_protocol_version/${mpId}`, 'demo|qa');
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const text = await res.text();
  const copy = JSON.parse(text);
  verify(copy);
  assert.equal(res.headers.get('x-content-sha256'), copy.content_sha256);
  assert.equal(copy.record.id, mpId);
  assert.ok(copy.audit_trail.length >= 1, 'audit trail included');
  assert.ok(copy.audit_trail.every((r: any, i: number, a: any[]) => i === 0 || a[i - 1].seq < r.seq), 'oldest first');
  assert.ok(copy.audit_trail.every((r: any) => /^[0-9a-f]{64}$/.test(r.hash)), 'entry hashes');
  const s = copy.signatures[0];
  assert.deepEqual([s.signer_name, s.meaning], ['Dana Whitfield', 'approval']);
  assert.match(s.signed_at, /Z$|\+00:00$/);
  assert.equal(copy.certified_copy.generated_by.sub, 'demo|qa');
  assert.match(copy.certified_copy.generated_at_utc, /Z$/);
  // CMP-13: the copy left the system, so it is in the access log with the hash of the file
  const log = await api.call('GET', '/v1/access-log?kind=export', { as: 'demo|qa' });
  const row = log.body.items.find((r: any) => r.seq === Number(res.headers.get('x-access-log-seq')));
  assert.equal(row.object, 'certified_copy:master_protocol_version');
  assert.equal(row.record_id, mpId);
  assert.equal(row.content_sha256, sha(text));
});

test('[CMP-14] the human-readable copy shows signatures with name, UTC time and meaning, and embeds the JSON', async () => {
  const res = await get(`/v1/certified-copies/master_protocol_version/${mpId}?format=html`, 'demo|admin');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  for (const s of ['Certified copy', 'Dana Whitfield', 'approval', 'Audit trail', 'Copy SHA-256', res.headers.get('x-content-sha256')!]) {
    assert.ok(html.includes(s), `html shows ${s}`);
  }
  assert.ok(!/<script/i.test(html), 'no script in the copy');
});

test('[CMP-14][IAM-04] a copy keeps blinding: a subject copy never shows the allocation to a blinded reviewer', async () => {
  const res = await get(`/v1/certified-copies/subject/${subjectId}`, 'demo|qa');
  assert.equal(res.status, 200);
  const copy: any = await res.json();
  assert.equal(copy.record.arm_id, null);
  assert.ok(copy.audit_trail.every((r: any) => !('arm_id' in (r.new_row ?? {})) && !('arm_id' in (r.old_row ?? {}))));
});

test('[CMP-14] a whole-trial copy holds every table of the platform, its audit trail and signatures, all verifiable', async () => {
  const res = await get(`/v1/platforms/${plat}/certified-copy`, 'demo|qa');
  assert.equal(res.status, 200);
  const copy: any = await res.json();
  verify(copy);
  assert.equal(copy.records.platform[0].id, plat);
  for (const t of ['arm', 'site', 'subject', 'master_protocol_version', 'arm_appendix_version', 'task']) {
    assert.ok(copy.records[t].length > 0, `${t} rows`);
    assert.equal(copy.certified_copy.scope.table_sha256[t], sha(canonical(copy.records[t])), `${t} hash`);
  }
  assert.ok(copy.records.subject.every((s: any) => s.arm_id === null), 'blinded');
  assert.ok(copy.audit_trail.length > 0 && copy.signatures.length >= 2);
});

test('[CMP-14] only QA auditors and platform admins make certified copies; unknown tables and ids are refused', async () => {
  assert.equal((await get(`/v1/certified-copies/master_protocol_version/${mpId}`, 'demo|ctm')).status, 403);
  assert.equal((await get(`/v1/platforms/${plat}/certified-copy`, 'demo|ctm')).status, 403);
  assert.equal((await get(`/v1/certified-copies/audit_event/${mpId}`, 'demo|qa')).status, 422);
  assert.equal((await get('/v1/certified-copies/arm/not-a-uuid', 'demo|qa')).status, 400);
  assert.equal((await get('/v1/certified-copies/arm/00000000-0000-0000-0000-000000000000', 'demo|qa')).status, 404);
});
