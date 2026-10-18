// Credibility assessment of a GxP AI task type (CMP-06, CMP-07). Runs the task type on its credibility dataset, scores
// the metrics pre-specified in the registry (= credibility plan §4) and writes the evidence to docs/ai/evidence/<task_type>/.
// Usage: TRIALOPS_AI_MODE=live node scripts/ai-credibility.mjs <task_type> [--dataset <dir>] [--dry-run]
//   --dataset  default: <registry dataset>/credibility (manifest.json + cases/*.json, format in services/ai-runtime/datasets/README.md)
//   --dry-run  required with the replay provider; the evidence is marked dry_run and never counts.
// Live calls spend money. Evidence counts only from a live run on a dataset with complete, independent provenance.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerFromEnv } from '../services/ai-runtime/src/runtime.ts';
import { REGISTRY } from '../services/ai-runtime/src/registry.ts';
import { runCredibility } from '../services/ai-runtime/src/credibility.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const taskType = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--dataset');
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
const ev = await runCredibility({ task_type: taskType, datasetDir, provider, dryRun });
const name = `${ev.run_at.slice(0, 10)}_${ev.dataset.dataset_id}_v${ev.dataset.version}_${ev.model}${ev.dry_run || ev.mode !== 'live' ? '_dry-run' : ''}.json`;
const file = join(root, 'docs/ai/evidence', taskType, name);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(ev, null, 2) + '\n');
for (const t of ev.thresholds) console.log(`${t.pass ? 'ok  ' : 'FAIL'} ${t.metric} ${t.op} ${t.value}: ${t.actual}`);
for (const p of ev.evidence_problems) console.log(`not evidence: ${p}`);
console.log(`${ev.passed ? 'PASSED' : 'NOT PASSED'} ${taskType} on ${ev.model} (${ev.mode}${ev.dry_run ? ', dry run' : ''}): ${ev.cases.length} cases → ${file}`);
process.exit(ev.passed ? 0 : 1);
