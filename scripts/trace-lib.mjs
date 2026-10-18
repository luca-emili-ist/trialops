// Traceability logic (VAL-01), pure functions shared by scripts/trace.mjs and its tests:
//   * every test name starts with the requirement IDs it covers: test('[M01-02][DM-03] ...');
//   * a test without IDs, or with an ID that is not in docs/requirements.json, is an error;
//   * a requirement passes only if all its tests ran and passed; a gated release with a requirement that does not pass
//     fails the build.

const TAGS = /^((?:\[[A-Z0-9][A-Z0-9-]*\])+)/;
const tagsOf = name => { const m = TAGS.exec(name); return m ? [...m[1].matchAll(/\[([A-Z0-9-]+)\]/g)].map(x => x[1]) : []; };
const unescapeXml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

/** Test cases of a JUnit XML report (node --test-reporter=junit): name and PASS / FAIL / SKIP. */
export function parseJunit(xml) {
  const out = [];
  // attribute values may contain a raw '>' (e.g. "draft -> active"): skip over quoted strings
  for (const m of xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
    if (name === undefined) continue;
    const inner = m[3] || '';
    out.push({ name: unescapeXml(name), result: /<(failure|error)\b/.test(inner) ? 'FAIL' : /<skipped\b/.test(inner) ? 'SKIP' : 'PASS' });
  }
  return out;
}

/** Tests declared in source files: test('...'), test("..."), test(`...`) and test.only/skip/todo. */
export function scanTests(sources) {
  const tests = [];
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/(?<![\w.$])test(?:\.(?:only|skip|todo))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const name = m[2];
      tests.push({ file, name, template: m[1] === '`' && name.includes('${'), reqs: tagsOf(name) });
    }
  }
  return tests;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Result of one source test from the report; a template name matches every case it generated. */
function resultOf(t, cases) {
  const re = t.template ? new RegExp('^' + t.name.split(/\$\{[^}]*\}/).map(escapeRe).join('[\\s\\S]*') + '$') : null;
  const hits = cases.filter(c => (re ? re.test(c.name) : c.name === t.name));
  if (!hits.length) return 'NOT RUN';
  if (hits.some(c => c.result === 'FAIL')) return 'FAIL';
  return hits.every(c => c.result === 'PASS') ? 'PASS' : 'NOT RUN';
}

/**
 * requirements: [{ id, release, text }]; tests: scanTests(); cases: parseJunit(); gate: releases that must pass.
 * Returns per-requirement rows, the gated requirements not passing, and the tagging errors.
 */
export function evaluate({ requirements, tests, cases, gate }) {
  const known = new Set(requirements.map(r => r.id));
  const errors = [];
  for (const t of tests) {
    if (!t.reqs.length) errors.push(`${t.file}: test without requirement IDs: "${t.name.slice(0, 80)}"`);
    for (const id of t.reqs) if (!known.has(id)) errors.push(`${t.file}: unknown requirement ID [${id}] in "${t.name.slice(0, 80)}"`);
  }
  for (const c of cases) if (!tagsOf(c.name).length) errors.push(`test run without requirement IDs: "${c.name.slice(0, 80)}"`);
  for (const t of tests) t.result = resultOf(t, cases);
  const rows = requirements.map(r => {
    const ts = tests.filter(t => t.reqs.includes(r.id));
    const result = !ts.length ? 'NO TEST' : ts.every(t => t.result === 'PASS') ? 'PASS' : ts.some(t => t.result === 'FAIL') ? 'FAIL' : 'NOT RUN';
    return { ...r, tests: ts, result };
  });
  const missing = rows.filter(r => gate.includes(r.release) && r.result !== 'PASS').map(r => `${r.id} (${r.release}: ${r.result})`);
  return { rows, missing, errors };
}
