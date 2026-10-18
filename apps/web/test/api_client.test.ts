// The web client sends a fresh Idempotency-Key with every write (APP-DT-02), none with reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, get, newIdempotencyKey } from '../src/api.ts';

test('[APP-DT-02] the web client sends a fresh Idempotency-Key with every write and none with reads', async () => {
  const seen: Record<string, string>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await api('POST', '/v1/x', { body: {} });
    await api('PATCH', '/v1/x', { body: {} });
    await get('/v1/x');
  } finally { globalThis.fetch = original; }
  const [post, patch, read] = seen;
  assert.match(post!['idempotency-key']!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(patch!['idempotency-key']);
  assert.notEqual(post!['idempotency-key'], patch!['idempotency-key']);
  assert.equal(read!['idempotency-key'], undefined);
  assert.notEqual(newIdempotencyKey(), newIdempotencyKey());
});
