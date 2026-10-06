// Builds the traceability matrix requirement -> test -> result from test names tagged [REQ-ID] (VAL-01).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFiles, rel } from './test-files.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = JSON.parse(readFileSync(join(root, 'docs/requirements.json'), 'utf8'));
// Releases whose requirements must all PASS. Foundations always; add the next one at its release: TRIALOPS_GATE=foundations,v0
const gate = (process.env.TRIALOPS_GATE || 'foundations').split(',').map(x => x.trim());
const passing = {};
const results = {};
if (existsSync(join(root, 'test-results.xml'))) {
  const xml = readFileSync(join(root, 'test-results.xml'), 'utf8');
  for (const m of xml.matchAll(/<testcase name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g))
    results[m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")] = /<failure/.test(m[3] || '') ? 'FAIL' : 'PASS';
}
const tests = [];
for (const path of testFiles(root)) {
  const f = rel(root, path);
  for (const m of readFileSync(path, 'utf8').matchAll(/test\('((?:\[[A-Z0-9-]+\])+)\s*([^']*)'/g)) {
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
  if (gate.includes(r.release) && res !== 'PASS') missing++;
  if (res === 'PASS') passing[r.release] = (passing[r.release] || 0) + 1;
  md += `| ${r.id} | ${r.release} | ${r.text} | ${t.map(x => x.file).filter((v, i, a) => a.indexOf(v) === i).join(', ') || '—'} (${t.length}) | ${res} |\n`;
}
writeFileSync(join(root, 'docs/traceability.md'), md);
const total = {};
for (const r of req.requirements) total[r.release] = (total[r.release] || 0) + 1;
const progress = Object.keys(total).map(k => `${k} ${passing[k] || 0}/${total[k]}`).join(', ');
console.log(`traceability: ${req.requirements.length} requirements, ${tests.length} tests; gate [${gate}] not passing: ${missing}; passing by release: ${progress}`);
if (missing) process.exitCode = 1;
