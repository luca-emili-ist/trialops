// VAL-01: the traceability gate (scripts/trace-lib.mjs, used by npm run trace in CI) on synthetic fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJunit, scanTests, evaluate } from '../../scripts/trace-lib.mjs';
import { testFiles, rel } from '../../scripts/test-files.mjs';

// Fixture sources are built from parts so that this file itself is not scanned as containing those tests.
const T = 'te' + 'st';
const requirements = [
  { id: 'GX-01', release: 'r1', text: 'gated, tested, passing' },
  { id: 'GX-02', release: 'r1', text: 'gated, tested, failing' },
  { id: 'GX-03', release: 'r1', text: 'gated, no test' },
  { id: 'GX-04', release: 'r2', text: 'not gated, no test' },
  { id: 'GX-05', release: 'r1', text: 'gated, generated tests (template name)' },
];
const source = { file: 'fixture.test.mjs', text: [
  `${T}('[GX-01] passes', () => {});`,
  `${T}('[GX-01] goes draft -> active', () => {});`,
  `${T}("[GX-01][GX-02] covers two", () => {});`,
  `${T}(\`[GX-05] case \${n} works\`, () => {});`,
  `${T}.skip('[GX-01] skipped one', () => {});`,
  'assert.ok(/x/.test(value));',
].join('\n') };
const junit = (cases) => `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${cases.map(([n, r]) =>
  `<testcase name="${n.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" time="0.001" classname="test"${r === 'PASS' ? '/>'
    : r === 'SKIP' ? '><skipped type="skipped"/></testcase>' : '><failure type="testCodeFailure">boom</failure></testcase>'}`).join('\n')}\n</testsuites>`;
const ALL_PASS = [['[GX-01] goes draft -> active', 'PASS'], ['[GX-01] passes', 'PASS'], ['[GX-01][GX-02] covers two', 'PASS'], ['[GX-05] case 1 works', 'PASS'],
  ['[GX-05] case 2 works', 'PASS'], ['[GX-01] skipped one', 'PASS']];

test('[VAL-01] test names carry their requirement IDs; tests without IDs or with unknown IDs fail the gate', () => {
  const tests = scanTests([source]);
  assert.deepEqual(tests.map(t => t.reqs), [['GX-01'], ['GX-01'], ['GX-01', 'GX-02'], ['GX-05'], ['GX-01']], 'regex .test() calls are not tests');
  const ok = evaluate({ requirements, tests, cases: parseJunit(junit(ALL_PASS)), gate: ['r1'] });
  assert.deepEqual(ok.errors, []);

  const bad = scanTests([{ file: 'bad.test.mjs', text: `${T}('no requirement here', () => {});\n${T}('[NOPE-99] unknown id', () => {});` }]);
  const r = evaluate({ requirements, tests: bad, cases: parseJunit(junit([['made up at run time', 'PASS']])), gate: [] });
  assert.equal(r.errors.length, 3, r.errors.join('\n'));
  assert.match(r.errors[0], /test without requirement IDs: "no requirement here"/);
  assert.match(r.errors[1], /unknown requirement ID \[NOPE-99\]/);
  assert.match(r.errors[2], /test run without requirement IDs: "made up at run time"/);
});

test('[VAL-01] the gate fails when a gated requirement has no test, a failing test or a test that did not run', () => {
  const run = cases => evaluate({ requirements: requirements.filter(x => x.id !== 'GX-03'), tests: scanTests([source]), cases: parseJunit(junit(cases)), gate: ['r1'] });
  assert.deepEqual(run(ALL_PASS).missing, [], 'all gated requirements pass');

  const failing = run(ALL_PASS.map(([n, r]) => [n, n.includes('covers two') ? 'FAIL' : r]));
  assert.deepEqual(failing.missing, ['GX-01 (r1: FAIL)', 'GX-02 (r1: FAIL)']);

  const notRun = run(ALL_PASS.filter(([n]) => n !== '[GX-01] passes'));
  assert.deepEqual(notRun.missing, ['GX-01 (r1: NOT RUN)']);

  const skipped = run(ALL_PASS.map(([n, r]) => [n, n.includes('skipped') ? 'SKIP' : r]));
  assert.deepEqual(skipped.missing, ['GX-01 (r1: NOT RUN)'], 'a skipped test is not a passing test');

  const oneGenerated = run(ALL_PASS.map(([n, r]) => [n, n === '[GX-05] case 2 works' ? 'FAIL' : r]));
  assert.deepEqual(oneGenerated.missing, ['GX-05 (r1: FAIL)'], 'every case generated from a template must pass');

  const noTest = evaluate({ requirements, tests: scanTests([source]), cases: parseJunit(junit(ALL_PASS)), gate: ['r1'] });
  assert.deepEqual(noTest.missing, ['GX-03 (r1: NO TEST)']);
  assert.equal(noTest.rows.find(x => x.id === 'GX-04').result, 'NO TEST', 'ungated requirements are reported, not enforced');
});

test('[VAL-01] every test of this repository carries known requirement IDs', () => {
  const root = new URL('../../', import.meta.url).pathname;
  const req = JSON.parse(readFileSync(new URL('../../docs/requirements.json', import.meta.url), 'utf8')).requirements;
  const tests = scanTests(testFiles(root).map(p => ({ file: rel(root, p), text: readFileSync(p, 'utf8') })));
  assert.ok(tests.length > 200);
  assert.deepEqual(evaluate({ requirements: req, tests, cases: [], gate: [] }).errors, []);
});
