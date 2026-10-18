// Credibility assessment of a GxP AI task type (CMP-06, CMP-07). Runs the task type on its credibility dataset, scores
// the metrics pre-specified in the registry (= credibility plan §4) and writes the evidence to docs/ai/evidence/<task_type>/.
// Usage: TRIALOPS_AI_MODE=live node scripts/ai-credibility.mjs <task_type> [--dataset <dir>] [--dry-run] [--max-usd <n>]
//   --dataset  default: <registry dataset>/credibility (manifest.json + cases/*.json, format in services/ai-runtime/datasets/README.md)
//   --dry-run  required with the replay provider; the evidence is marked dry_run and never counts.
//   --max-usd  budget cap at list price (default 15): before each call the run stops if spend so far plus the worst case of
//              that call (max_tokens of output) would exceed it. Tokens and cost are written to the evidence (usage).
// Live calls spend money. Evidence counts only from a live run on a dataset with complete, independent provenance.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerFromEnv, PRICE_USD_PER_MTOK } from '../services/ai-runtime/src/runtime.ts';
import { REGISTRY } from '../services/ai-runtime/src/registry.ts';
import { runCredibility } from '../services/ai-runtime/src/credibility.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const taskType = args.find((a, i) => !a.startsWith('--') && !['--dataset', '--max-usd'].includes(args[i - 1]));
const maxUsd = args.includes('--max-usd') ? Number(args[args.indexOf('--max-usd') + 1]) : 15;
const dryRun = args.includes('--dry-run');
const def = taskType ? REGISTRY[taskType] : undefined;
if (!def) {
  console.error(`usage: node scripts/ai-credibility.mjs <task_type> [--dataset <dir>] [--dry-run]; task types: ${Object.keys(REGISTRY).join(', ')}`);
  process.exit(2);
}
const datasetDir = args.includes('--dataset') ? resolve(args[args.indexOf('--dataset') + 1]) : join(root, def.dataset, 'credibility');
const provider = providerFromEnv();
if (provider.name === 'replay' && !dryRun) {
  console.error('the replay provider answers from recordings: use --dry-run, or TRIALOPS_AI_MODE=live for evidence');
  process.exit(2);
}
// Usage meter and budget cap: wraps the provider, counts tokens per call (cases run in order) and refuses a call that
// could take the spend above --max-usd. It changes nothing of what reaches the model.
const price = PRICE_USD_PER_MTOK[def.model] ?? { in: 0, out: 0 };
const usd = (i, o) => (i * price.in + o * price.out) / 1e6;
const calls = []; const outputs = []; let spent = 0;
const metered = { ...provider, call: async c => {
  const worst = usd(Math.ceil((c.system.length + c.user.length) / 3), c.max_tokens);
  if (spent + worst > maxUsd) throw new Error(`budget cap: spent ${spent.toFixed(2)} USD, next call up to ${worst.toFixed(2)} USD > --max-usd ${maxUsd}`);
  const t0 = Date.now();
  try {
    const r = await provider.call(c);
    const u = { input_tokens: r.input_tokens ?? 0, output_tokens: r.output_tokens ?? 0, latency_ms: Date.now() - t0 };
    spent += usd(u.input_tokens, u.output_tokens); calls.push(u); outputs.push(r.output ?? null);
    console.error(`call ${calls.length}: ${u.input_tokens} in / ${u.output_tokens} out, ${(u.latency_ms / 1000).toFixed(0)} s, total ${spent.toFixed(2)} USD`);
    return r;
  } catch (e) { outputs.push(null); calls.push({ input_tokens: null, output_tokens: null, latency_ms: Date.now() - t0, error: e.message }); console.error(`call ${calls.length}: ${e.message}`); throw e; }
} };
const ev = await runCredibility({ task_type: taskType, datasetDir, provider: metered, dryRun });
const tin = calls.reduce((a, c) => a + (c.input_tokens ?? 0), 0); const tout = calls.reduce((a, c) => a + (c.output_tokens ?? 0), 0);
ev.usage = { calls: calls.length, input_tokens: tin, output_tokens: tout, usd_list_price: Math.round(usd(tin, tout) * 1e4) / 1e4,
  price_usd_per_mtok: price, max_usd: maxUsd, per_call: calls.map((c, i) => ({ case_id: ev.cases[i]?.case_id ?? null, ...c })) };
const name = `${ev.run_at.slice(0, 10)}_${ev.dataset.dataset_id}_v${ev.dataset.version}_${ev.model}${ev.dry_run || ev.mode !== 'live' ? '_dry-run' : ''}.json`;
const file = join(root, 'docs/ai/evidence', taskType, name);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(ev, null, 2) + '\n');
// Raw model answers next to the evidence, for the human review of failures (synthetic data only, rule 7).
if (outputs.some(o => o !== null)) {
  writeFileSync(file.replace(/\.json$/, '_outputs.json'), JSON.stringify(ev.cases.map((c, i) => ({ case_id: c.case_id, outcome: c.outcome,
    ...(c.error ? { error: c.error } : {}), output: outputs[i] ?? null })), null, 2) + '\n');
}
for (const t of ev.thresholds) console.log(`${t.pass ? "ok  " : "FAIL"} ${t.metric} ${t.op} ${t.value}: ${t.actual}${t.note ? ` (${t.note})` : ""}`);
console.log(`outcomes: ${Object.entries(ev.metrics).filter(([k]) => k.startsWith("outcome_")).map(([k, v]) => `${k.slice(8)} ${v}`).join(", ")}; cases without output: ${ev.metrics.cases_without_output}${ev.aborted ? "; ABORTED" : ""}`);
for (const p of ev.evidence_problems) console.log(`not evidence: ${p}`);
console.log(`usage: ${ev.usage.calls} calls, ${tin} input + ${tout} output tokens, ${ev.usage.usd_list_price} USD at list price`);
console.log(`${ev.passed ? 'PASSED' : 'NOT PASSED'} ${taskType} on ${ev.model} (${ev.mode}${ev.dry_run ? ', dry run' : ''}): ${ev.cases.length} cases → ${file}`);
process.exit(ev.passed ? 0 : 1);
