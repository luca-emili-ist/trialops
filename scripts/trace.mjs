// Builds the traceability matrix requirement -> test -> result from test names tagged [REQ-ID] (VAL-01).
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = JSON.parse(readFileSync(join(root, 'docs/requirements.json'), 'utf8'));
const results = {};
if (existsSync(join(root, 'test-results.xml'))) {
  const xml = readFileSync(join(root, 'test-results.xml'), 'utf8');
  for (const m of xml.matchAll(/<testcase name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g))
    results[m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")] = /<failure/.test(m[3] || '') ? 'FAIL' : 'PASS';
}
const tests = [];
for (const f of readdirSync(join(root, 'db/tests')).filter(f => f.endsWith('.test.mjs'))) {
  for (const m of readFileSync(join(root, 'db/tests', f), 'utf8').matchAll(/test\('((?:\[[A-Z0-9-]+\])+)\s*([^']*)'/g)) {
    const name = m[1] + ' ' + m[2];
    tests.push({ file: f, name, reqs: [...m[1].matchAll(/\[([A-Z0-9-]+)\]/g)].map(x => x[1]), result: results[name] || 'NOT RUN' });
  }
}
let md = `# Traceability matrix\n\nGenerated ${new Date().toISOString()} by scripts/trace.mjs from test tags and test-results.xml.\n\n`;
md += '| Requirement | Release | Description | Tests | Result |\n| --- | --- | --- | --- | --- |\n';
let missing = 0;
for (const r of req.requirements) {
  const t = tests.filter(x => x.reqs.includes(r.id));
  const res = !t.length ? 'NO TEST' : t.every(x => x.result === 'PASS') ? 'PASS' : t.some(x => x.result === 'FAIL') ? 'FAIL' : 'NOT RUN';
  if (r.release === 'foundations' && res !== 'PASS') missing++;
  md += `| ${r.id} | ${r.release} | ${r.text} | ${t.map(x => x.file).filter((v, i, a) => a.indexOf(v) === i).join(', ') || '—'} (${t.length}) | ${res} |\n`;
}
writeFileSync(join(root, 'docs/traceability.md'), md);
console.log(`traceability: ${req.requirements.length} requirements, ${tests.length} tests; foundations requirements not passing: ${missing}`);
if (missing) process.exitCode = 1;
