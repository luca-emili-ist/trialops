// House rule §19: every page has a stable, unique code; and the design-system rule: pages use tokens, never raw colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_CODES } from '../src/pageCodes.ts';
import { ROUTE_PATTERNS, parse } from '../src/router.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');

test('[DEMO-04] page codes are unique, well formed and cover every route', () => {
  const codes = Object.values(PAGE_CODES);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.match(c, /^TRO-\d{3}$/);
  for (const r of ROUTE_PATTERNS) assert.ok(PAGE_CODES[r.page], `route ${r.re} has no page code`);
  assert.equal(parse('#/nope').page, 'notFound');
  assert.deepEqual(parse('#/protocol/appendix/00000000-0000-4000-8000-000000000000'), { page: 'protocolEditor', params: { kind: 'appendix', id: '00000000-0000-4000-8000-000000000000' } });
});

test('[DEMO-04] pages use design tokens only: no hex colours, rgb() or inline colour styles', () => {
  for (const dir of ['pages', 'components']) for (const f of readdirSync(join(src, dir))) {
    const code = readFileSync(join(src, dir, f), 'utf8');
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,6}\b(?![\w/-]*['"]?\])/, `${dir}/${f} contains a hex colour`);
    assert.doesNotMatch(code, /rgba?\(/, `${dir}/${f} contains rgb()`);
    assert.doesNotMatch(code, /style=\{\{[^}]*(color|background|font)/, `${dir}/${f} sets colours or fonts inline`);
  }
});

test('[DEMO-04] the synthetic-data label is on every page of the shell', () => {
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  assert.match(app, /banner="Synthetic data — demonstration environment"/);
  for (const f of ['Login.tsx', 'UiCatalogue.tsx']) assert.match(readFileSync(join(src, 'pages', f), 'utf8'), /Synthetic data — demonstration environment/);
});
