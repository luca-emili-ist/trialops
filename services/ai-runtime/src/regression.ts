// Model change regression (AI-03): runs the test dataset of a task type through the runtime with a candidate model and
// writes the evidence that a model change request must attach in model-lock.json. Thresholds are the ones of the task
// type's credibility plan (docs/ai/<task_type>.md); here the generic floor: every case must run and pass the schema.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiRuntime } from './runtime.ts';
import { REGISTRY } from './registry.ts';
import { canonical, sha256 } from './canonical.ts';
import type { AiTaskRequest, Provider } from './types.ts';

export const DATASETS = join(dirname(fileURLToPath(import.meta.url)), '../datasets');
export const MODEL_LOCK = join(dirname(fileURLToPath(import.meta.url)), '../model-lock.json');

export interface Approval {
  model: string;
  approved_on: string;
  approved_by: string | null;
  change_request: string | null;
  regression_evidence: string | null;
  reason: string;
}
export interface ModelLock { task_types: Record<string, { approvals: Approval[] }> }

export interface RegressionEvidence {
  task_type: string;
  model: string;
  previous_model: string;
  provider: string;
  mode: 'live' | 'replay';
  run_at: string;                      // server UTC (rule 11)
  dataset_sha256: string;
  cases: { case: string; outcome: string; error?: string }[];
  schema_valid_rate: number;
  passed: boolean;
}

export const readModelLock = (file = MODEL_LOCK): ModelLock => JSON.parse(readFileSync(file, 'utf8'));

/** The dataset of a task type: datasets/<task_type>/*.json, each { data_class, input }. */
export function readDataset(task_type: string, dir = DATASETS): { case: string; req: AiTaskRequest }[] {
  const d = join(dir, task_type);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => {
    const c = JSON.parse(readFileSync(join(d, f), 'utf8'));
    return { case: f, req: { task_type, data_class: c.data_class, input: c.input } };
  });
}

export async function runRegression(opts: { task_type: string; model: string; provider: Provider; datasetDir?: string }): Promise<RegressionEvidence> {
  const def = REGISTRY[opts.task_type];
  if (!def) throw new Error(`task_type ${opts.task_type} is not registered`);
  const lock = readModelLock().task_types[opts.task_type];
  const previous = lock?.approvals.at(-1)?.model ?? def.model;
  const dataset = readDataset(opts.task_type, opts.datasetDir);
  if (dataset.length === 0) throw new Error(`no test dataset for ${opts.task_type} (datasets/${opts.task_type}/*.json)`);
  const rt = createAiRuntime({ provider: opts.provider, registry: { [opts.task_type]: { ...def, model: opts.model } } });
  const db = { query: async () => ({ rows: [{ id: 'regression' }] }) };   // evaluation runs are evidence, not ledger rows
  const cases: RegressionEvidence['cases'] = [];
  for (const c of dataset) {
    const r = await rt.run(c.req, { db });
    cases.push({ case: c.case, outcome: r.outcome, ...(r.error ? { error: r.error } : {}) });
  }
  const valid = cases.filter(c => c.outcome === 'success').length / cases.length;
  return {
    task_type: opts.task_type, model: opts.model, previous_model: previous, provider: opts.provider.name,
    mode: opts.provider.name === 'replay' ? 'replay' : 'live', run_at: new Date().toISOString(),
    dataset_sha256: sha256(canonical(dataset.map(c => ({ case: c.case, ...c.req })))), cases,
    schema_valid_rate: valid, passed: valid === 1,
  };
}
