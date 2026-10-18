// Builds the traceability matrix requirement -> test -> result from test names tagged [REQ-ID] (VAL-01).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFiles, rel } from './test-files.mjs';
import { parseJunit, scanTests, evaluate } from './trace-lib.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = JSON.parse(readFileSync(join(root, 'docs/requirements.json'), 'utf8'));
// Releases whose requirements must all PASS. Foundations always; add the next one at its release: TRIALOPS_GATE=foundations,v0
const gate = (process.env.TRIALOPS_GATE || 'foundations').split(',').map(x => x.trim());
const passing = {};
const cases = existsSync(join(root, 'test-results.xml')) ? parseJunit(readFileSync(join(root, 'test-results.xml'), 'utf8')) : [];
const tests = scanTests(testFiles(root).map(path => ({ file: rel(root, path), text: readFileSync(path, 'utf8') })));
const { rows, missing: gatedMissing, errors: tagErrors } = evaluate({ requirements: req.requirements, tests, cases, gate });
let md = `# Traceability matrix\n\nGenerated ${new Date().toISOString()} by scripts/trace.mjs from test tags and test-results.xml.\n\n`;
md += '| Requirement | Release | Description | Tests | Result |\n| --- | --- | --- | --- | --- |\n';
const missing = gatedMissing.length;
for (const r of rows) {
  if (r.result === 'PASS') passing[r.release] = (passing[r.release] || 0) + 1;
  md += `| ${r.id} | ${r.release} | ${r.text} | ${r.tests.map(x => x.file).filter((v, i, a) => a.indexOf(v) === i).join(', ') || '—'} (${r.tests.length}) | ${r.result} |\n`;
}
writeFileSync(join(root, 'docs/traceability.md'), md);

// Compliance fields (VAL-05): every requirement declares GxP impact, risk, assurance and the regulatory clauses it serves.
const cw = JSON.parse(readFileSync(join(root, 'docs/compliance/crosswalk.json'), 'utf8'));
const codes = new Map(cw.clauses.map(c => [c.code, c]));
const errors = [];
const enums = { gxp_impact: ['direct', 'indirect', 'none'], risk: ['high', 'medium', 'low'], assurance: ['scripted', 'automated', 'unscripted'] };
for (const r of req.requirements) {
  for (const [k, allowed] of Object.entries(enums)) if (!allowed.includes(r[k])) errors.push(`${r.id}: ${k} must be one of ${allowed.join('/')}`);
  if (!Array.isArray(r.regs)) { errors.push(`${r.id}: regs missing`); continue; }
  for (const c of r.regs) if (!codes.has(c)) errors.push(`${r.id}: unknown regulatory clause ${c}`);
  if (r.gxp_impact === 'direct' && !r.regs.length) errors.push(`${r.id}: direct GxP impact without regulatory references`);
  if (r.risk === 'high' && r.assurance !== 'scripted') errors.push(`${r.id}: high risk requires scripted assurance (CSA)`);
}
const status = Object.fromEntries(rows.map(r => [r.id + '|' + r.release, r.result]));
let cm = `# Compliance matrix\n\nGenerated ${new Date().toISOString()} by scripts/trace.mjs from docs/compliance/crosswalk.json and docs/requirements.json.\n`;
cm += 'Technical clauses are covered by requirements and their tests; procedural clauses are covered by SOPs of the quality system.\n';
let gaps = 0;
for (const [fw, title] of Object.entries(cw.frameworks)) {
  cm += `\n## ${fw} — ${title}\n\n| Clause | Ref | Title | Control | Requirements (release: result) | Status |\n| --- | --- | --- | --- | --- | --- |\n`;
  for (const c of cw.clauses.filter(x => x.framework === fw)) {
    const rs = req.requirements.filter(r => r.regs?.includes(c.code));
    const cells = rs.map(r => `${r.id} (${r.release}: ${status[r.id + '|' + r.release]})`).join(', ');
    const st = c.control === 'procedural' ? 'SOP' : !rs.length ? 'GAP — no requirement' : rs.every(r => status[r.id + '|' + r.release] === 'PASS') ? 'covered'
      : rs.some(r => status[r.id + '|' + r.release] === 'PASS') ? 'partial' : 'planned';
    if (st.startsWith('GAP')) gaps++;
    cm += `| ${c.code} | ${c.ref} | ${c.title} | ${c.control} | ${cells || '—'} | ${st} |\n`;
  }
}
writeFileSync(join(root, 'docs/compliance/compliance-matrix.md'), cm);
console.log(`compliance: ${cw.clauses.length} clauses, ${gaps} technical gaps without requirement, ${errors.length} requirement errors`);
for (const e of errors) console.error('  ' + e);
if (errors.length) process.exitCode = 1;
const total = {};
for (const r of req.requirements) total[r.release] = (total[r.release] || 0) + 1;
const progress = Object.keys(total).map(k => `${k} ${passing[k] || 0}/${total[k]}`).join(', ');
console.log(`traceability: ${req.requirements.length} requirements, ${tests.length} tests, ${cases.length} results; gate [${gate}] not passing: ${missing}; ` +
  `passing by release: ${progress}; tagging errors: ${tagErrors.length}`);
for (const m of gatedMissing) console.error('  gated requirement not passing: ' + m);
for (const e of tagErrors) console.error('  ' + e);
if (missing || tagErrors.length) process.exitCode = 1;
