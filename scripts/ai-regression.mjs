// Regression of a task type on a candidate model (AI-03). Writes the evidence a model change request attaches.
// Usage: TRIALOPS_AI_MODE=live node scripts/ai-regression.mjs <task_type> <candidate_model>
// Live calls spend money: run it only for an open model change request. Replay mode is accepted for a dry run, but
// test [AI-03] refuses replay evidence in model-lock.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerFromEnv } from '../services/ai-runtime/src/runtime.ts';
import { runRegression } from '../services/ai-runtime/src/regression.ts';

const [taskType, model] = process.argv.slice(2);
if (!taskType || !model) {
  console.error('usage: node scripts/ai-regression.mjs <task_type> <candidate_model>');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = await runRegression({ task_type: taskType, model, provider: providerFromEnv() });
const file = join(root, 'docs/ai/evidence', taskType, `${evidence.run_at.slice(0, 10)}_${model}_regression.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
console.log(`${evidence.passed ? 'PASSED' : 'FAILED'} ${taskType} on ${model} (${evidence.mode}): ` +
  `${evidence.cases.length} cases, schema valid ${(evidence.schema_valid_rate * 100).toFixed(1)}% → ${file}`);
process.exit(evidence.passed ? 0 : 1);
