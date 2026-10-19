// EDC pages (TRO-070…TRO-075): own codes in the Data decade, routes, navigation, localisable strings, blinding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_CODES } from '../src/pageCodes.ts';
import { parse } from '../src/router.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
const page = (f: string) => readFileSync(join(src, 'pages', f), 'utf8');
const ID = '00000000-0000-4000-8000-000000000000';

test('[EDC-01][EDC-03][EDC-05] the EDC pages have their own codes in the Data decade and their routes', () => {
  assert.deepEqual([PAGE_CODES.crfLibrary, PAGE_CODES.crfVersion, PAGE_CODES.edcSubjects, PAGE_CODES.edcCasebook, PAGE_CODES.edcVisit, PAGE_CODES.edcQueries],
    ['TRO-070', 'TRO-071', 'TRO-072', 'TRO-073', 'TRO-074', 'TRO-075']);
  assert.deepEqual(parse('#/edc/crfs'), { page: 'crfLibrary', params: {} });
  assert.deepEqual(parse(`#/edc/crfs/${ID}`), { page: 'crfVersion', params: { id: ID } });
  assert.deepEqual(parse('#/edc'), { page: 'edcSubjects', params: {} });
  assert.deepEqual(parse(`#/edc/subjects/${ID}`), { page: 'edcCasebook', params: { id: ID } });
  assert.deepEqual(parse(`#/edc/visits/${ID}`), { page: 'edcVisit', params: { id: ID } });
  assert.deepEqual(parse('#/edc/queries'), { page: 'edcQueries', params: {} });
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  assert.match(app, /label: 'Data entry', href: '#\/edc', pages: \['edcSubjects', 'edcCasebook', 'edcVisit'\], group: 'Data', roles: EDC_READER_ROLES/);
  assert.match(app, /label: 'Data queries', href: '#\/edc\/queries', pages: \['edcQueries'\], group: 'Data', roles: EDC_READER_ROLES/);
  assert.match(app, /label: 'CRF library', href: '#\/edc\/crfs', pages: \['crfLibrary', 'crfVersion'\], group: 'Data'/);
});

test('[EDC-03][NFR-07] UI strings of every EDC page are kept in one place per page and go through t() (rule 15)', () => {
  for (const f of ['EdcLibrary.tsx', 'EdcDataEntry.tsx', 'EdcQueries.tsx']) {
    const p = page(f);
    assert.match(p, /\nconst T = \(t: Tr\) => \(\{[\s\S]*?\n\}\);/, `${f}: strings object built with t()`);
    assert.match(p, /= T\(t\)/, `${f}: strings taken in the locale of the page`);
    // labels of fields and buttons come from T, not from literals in the JSX
    assert.doesNotMatch(p, /label="[A-Za-z]/, `${f}: literal field label`);
    assert.doesNotMatch(p, /<Button[^>]*>[A-Za-z][^<{]*<\/Button>/, `${f}: literal button text`);
  }
});

test('[EDC-11] the EDC pages never ask for or show the allocation', () => {
  for (const f of ['EdcLibrary.tsx', 'EdcDataEntry.tsx', 'EdcQueries.tsx']) assert.doesNotMatch(page(f), /arm_id|arm_code|sac_enclave/i, f);
});

test('[EDC-01][CMP-11] a CRF version is approved with a signature of meaning approval and shows its manifestation', () => {
  const p = page('EdcLibrary.tsx');
  assert.match(p, /<SignDialog[^>]*meaning="approval"/);
  assert.match(p, /onSign=\{async \(password, reason, totp\) =>/);
  assert.match(p, /<SignatureManifest signature=\{d\.approved_signature\}/);
});

test('[EDC-03][DM-03] changing saved values asks for a reason; times are shown in UTC (rule 11)', () => {
  const p = page('EdcDataEntry.tsx');
  assert.match(p, /changesSaved \? setDialog\('reason'\)/);
  assert.match(p, /<ReasonDialog title=\{V\.reasonTitle\}/);
  assert.match(readFileSync(join(src, 'components', 'edc.ts'), 'utf8'), /UTC`/);
});
