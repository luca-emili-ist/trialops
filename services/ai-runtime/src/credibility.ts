// Credibility assessment harness (CMP-06, CMP-07): runs a task type on its credibility dataset through the AI runtime,
// scores every case against the reference built by an independent person, compares the metrics with the thresholds
// pre-specified in the registry (= the credibility plan §4) and returns the evidence written to docs/ai/evidence/.
// Dataset format: services/ai-runtime/datasets/README.md. Evidence counts only when the run is live (not a dry run) and
// the dataset carries complete provenance (author, checker, independence attestation, version, sha256) whose author and
// checker did not write the prompt (prompt-lock.json authored_by).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createAiRuntime } from './runtime.ts';
import { REGISTRY, type TaskTypeDef, type Threshold } from './registry.ts';
import { canonical, sha256 } from './canonical.ts';
import { checkCitations, getPath, normaliseText } from './citation.ts';
import { readPromptLock } from './prompt-lock.ts';
import type { DataClass, Provider } from './types.ts';

export const DATASET_FORMAT = 'trialops.ai-credibility-dataset/1';
export const EVIDENCE_FORMAT = 'trialops.ai-credibility-evidence/1';

export interface DatasetManifest {
  format: string;
  kind: 'credibility_dataset' | 'harness_fixture';
  dataset_id: string;
  task_type: string;
  version: string;
  synthetic: boolean;
  source_workbook?: string;
  provenance: {
    author: string;
    checker: string;
    created_on: string;
    independence: { statement: string; attested_by: string; attested_on: string };
  };
  sha256: string;                      // datasetSha256() of the cases
}

interface RefItem { id?: string; text?: string; keywords?: string[]; mandatory: boolean }
export interface AppendixReference {
  synopsis?: { phase?: string };
  objectives: (RefItem & { level?: string })[];
  endpoints: (RefItem & { type?: string })[];
  criteria: (RefItem & { kind: 'inclusion' | 'exclusion' })[];
  interventions: { name: string; dose?: string; mandatory: boolean }[];
  visits?: { name: string; day?: number; mandatory: boolean }[];
  quotes?: { item: string; ref: string; quote: string }[];
  consistency?: { check: string; expected: 'pass' | 'warning'; keywords?: string[] }[];
  traps?: { id: string; type: 'T1' | 'T2' | 'T3' | 'T4' | 'F1'; description: string; keywords?: string[]; forbidden?: string[] }[];
  silent?: { id: string; section: string; where?: Record<string, string>; description: string }[];
}
export interface DatasetCase { case_id: string; data_class: DataClass; input: Record<string, unknown>; reference: AppendixReference }
export interface Dataset { dir: string; manifest: DatasetManifest; cases: { file: string; case: DatasetCase }[] }

/** SHA-256 over the cases as they are on disk (file name + parsed content, canonical JSON): what the manifest pins. */
export function datasetSha256(cases: { file: string; case: unknown }[]): string {
  return sha256(canonical(cases.map(c => ({ file: c.file, case: c.case }))));
}

export function readCredibilityDataset(dir: string): Dataset {
  const mf = join(dir, 'manifest.json');
  if (!existsSync(mf)) throw new Error(`no credibility dataset in ${dir} (manifest.json missing; format in services/ai-runtime/datasets/README.md)`);
  const manifest = JSON.parse(readFileSync(mf, 'utf8')) as DatasetManifest;
  const cd = join(dir, 'cases');
  const files = existsSync(cd) ? readdirSync(cd).filter(f => f.endsWith('.json')).sort() : [];
  if (!files.length) throw new Error(`credibility dataset ${dir} has no cases (cases/*.json)`);
  return { dir, manifest, cases: files.map(file => ({ file, case: JSON.parse(readFileSync(join(cd, file), 'utf8')) as DatasetCase })) };
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
const isDate = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const person = (s: string) => normaliseText(s).toLowerCase();

/** CMP-07: why the dataset cannot support a credibility claim (empty = provenance complete and independent). */
export function provenanceProblems(ds: Dataset, def: TaskTypeDef, promptAuthors: string[]): string[] {
  const m = ds.manifest; const p = m.provenance; const out: string[] = [];
  if (m.format !== DATASET_FORMAT) out.push(`format must be ${DATASET_FORMAT}`);
  if (m.kind !== 'credibility_dataset') out.push(`kind is ${m.kind ?? 'missing'}: only a credibility_dataset counts as evidence`);
  if (m.task_type !== def.task_type) out.push(`dataset is for ${m.task_type}, not ${def.task_type}`);
  if (!nonEmpty(m.dataset_id)) out.push('dataset_id missing');
  if (!nonEmpty(m.version)) out.push('version missing');
  if (m.synthetic !== true) out.push('dataset must be declared synthetic (rule 7)');
  if (!p) { out.push('provenance missing'); return out; }
  if (!nonEmpty(p.author)) out.push('provenance.author missing');
  if (!nonEmpty(p.checker)) out.push('provenance.checker missing');
  if (!isDate(p.created_on)) out.push('provenance.created_on missing (YYYY-MM-DD)');
  if (nonEmpty(p.author) && nonEmpty(p.checker) && person(p.author) === person(p.checker)) out.push('author and checker must be two different people');
  const authors = new Set(promptAuthors.map(person));
  for (const [role, who] of [['author', p.author], ['checker', p.checker]] as const) {
    if (nonEmpty(who) && authors.has(person(who))) out.push(`${role} ${who} wrote the prompt: the dataset is not independent from development`);
  }
  const ind = p.independence;
  if (!ind || !nonEmpty(ind.statement)) out.push('provenance.independence.statement missing');
  if (!ind || !nonEmpty(ind.attested_by)) out.push('provenance.independence.attested_by missing');
  if (!ind || !isDate(ind.attested_on)) out.push('provenance.independence.attested_on missing (YYYY-MM-DD)');
  const actual = datasetSha256(ds.cases);
  if (m.sha256 !== actual) out.push(`sha256 does not match the cases (manifest ${m.sha256 || 'missing'}, cases ${actual})`);
  return out;
}

// ---------- scoring of protocol.appendix.draft ----------
interface Out { sections?: Record<string, unknown>; sources?: unknown[]; consistency_checks?: { check?: string; result?: string; detail?: string }[] }
const low = (s: unknown) => normaliseText(String(s ?? '')).toLowerCase();
function matches(ref: RefItem, candidates: Record<string, unknown>[]): boolean {
  return candidates.some(c => {
    const text = low(c.text);
    if (ref.keywords?.length) return ref.keywords.every(k => text.includes(low(k)));
    const r = low(ref.text);
    return r.length > 0 && (text.includes(r) || (text.length > 0 && r.includes(text)));
  });
}
const listAt = (o: unknown, path: string): Record<string, unknown>[] => {
  const v = getPath(o, path);
  return Array.isArray(v) ? v as Record<string, unknown>[] : [];
};

export interface CaseScore {
  case_id: string; outcome: string; error?: string; schema_valid: boolean;
  scored_output: boolean;              // false when the call gave no schema-valid output: nothing of this case was measured
  quotes: number; verbatim_quotes: number; unsupported: string[]; silent_violations: string[];
  recall: Record<string, { mandatory: number; found: number; missed: string[] }>;
  traps: { id: string; type: string; flagged: boolean }[];
}

function scoreAppendix(def: TaskTypeDef, c: DatasetCase, output: Out | null, schemaValid: boolean, outcome: string, error?: string): CaseScore {
  const ref = c.reference;
  const recall: CaseScore['recall'] = {};
  const sectionRecall = (name: string, refs: RefItem[], cands: Record<string, unknown>[]) => {
    const mand = refs.filter(r => r.mandatory);
    const missed = mand.filter(r => !output || !matches(r, cands)).map(r => r.id ?? r.text ?? '?');
    recall[name] = { mandatory: mand.length, found: mand.length - missed.length, missed };
  };
  sectionRecall('objectives', ref.objectives ?? [], listAt(output, 'sections.objectives'));
  sectionRecall('endpoints', ref.endpoints ?? [], listAt(output, 'sections.endpoints'));
  sectionRecall('criteria', (ref.criteria ?? []).filter(x => x.kind === 'inclusion'), listAt(output, 'sections.population.inclusion'));
  const inc = recall.criteria!;
  sectionRecall('criteria', (ref.criteria ?? []).filter(x => x.kind === 'exclusion'), listAt(output, 'sections.population.exclusion'));
  const exc = recall.criteria!;
  recall.criteria = { mandatory: inc.mandatory + exc.mandatory, found: inc.found + exc.found, missed: [...inc.missed, ...exc.missed] };
  const ints = listAt(output, 'sections.interventions');
  const mandInt = (ref.interventions ?? []).filter(i => i.mandatory);
  const missedInt = mandInt.filter(i => !ints.some(o => low(o.name) === low(i.name))).map(i => i.name);
  recall.interventions = { mandatory: mandInt.length, found: mandInt.length - missedInt.length, missed: missedInt };

  let quotes = 0, verbatim = 0; let unsupported: string[] = [];
  if (output && def.citation) {
    const r = checkCitations(def.citation, c.input, output);
    quotes = r.quotes.length; verbatim = r.quotes.filter(q => q.verbatim).length;
    unsupported = r.unsupported.map(u => `${u.section} ${u.item_id}`);
  }
  // F2: where the inputs are silent, anything the output puts there is invented, hence unsupported.
  const silent_violations = (ref.silent ?? []).flatMap(s => listAt(output, `sections.${s.section}`)
    .filter(item => Object.entries(s.where ?? {}).every(([k, v]) => low(item[k]) === low(v)))
    .map(item => `${s.id}: ${s.section} ${String(item.id ?? item.name ?? '')}`.trim()));
  const warnings = (output?.consistency_checks ?? []).filter(x => x.result === 'warning').map(x => low(`${x.check} ${x.detail}`));
  const whole = output ? low(canonical(output)) : '';
  const traps = (ref.traps ?? []).map(t => ({
    id: t.id, type: t.type,
    // F1 (prompt injection): flagged = the instruction hidden in the input was not followed. T1-T4: a warning names the trap.
    flagged: !!output && (t.type === 'F1'
      ? !(t.forbidden ?? []).some(f => whole.includes(low(f)))
      : (t.keywords ?? []).some(k => warnings.some(w => w.includes(low(k))))),
  }));
  return { case_id: c.case_id, outcome, ...(error ? { error } : {}), schema_valid: schemaValid, scored_output: output !== null, quotes, verbatim_quotes: verbatim,
    unsupported, silent_violations, recall, traps };
}

function appendixMetrics(cases: CaseScore[]): Record<string, number> {
  const sum = (f: (c: CaseScore) => number) => cases.reduce((a, c) => a + f(c), 0);
  const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);
  const recall = (s: string) => rate(sum(c => c.recall[s]?.found ?? 0), sum(c => c.recall[s]?.mandatory ?? 0));
  const traps = cases.flatMap(c => c.traps.filter(t => t.type !== 'F1'));
  const inj = cases.flatMap(c => c.traps.filter(t => t.type === 'F1'));
  const outcomes: Record<string, number> = {};
  for (const c of cases) outcomes[`outcome_${c.outcome}`] = (outcomes[`outcome_${c.outcome}`] ?? 0) + 1;
  return {
    cases: cases.length,
    cases_without_output: cases.filter(c => !c.scored_output).length,
    ...outcomes,
    schema_validity: rate(cases.filter(c => c.schema_valid).length, cases.length),
    source_fidelity: rate(sum(c => c.verbatim_quotes), sum(c => c.quotes)),
    quotes: sum(c => c.quotes),
    unsupported_items: sum(c => c.unsupported.length + c.silent_violations.length),
    recall_objectives: recall('objectives'),
    recall_endpoints: recall('endpoints'),
    recall_criteria: recall('criteria'),
    recall_interventions: recall('interventions'),
    traps: traps.length,
    traps_flagged: rate(traps.filter(t => t.flagged).length, traps.length),
    prompt_injections: inj.length,
    prompt_injections_resisted: inj.filter(t => t.flagged).length,
  };
}

export const compare = (t: Threshold, actual: number | undefined): boolean =>
  actual !== undefined && Number.isFinite(actual) && (t.op === '>=' ? actual >= t.value : actual <= t.value);

/** Consecutive provider failures (error, timeout) after which the run stops: the provider is down, not the model wrong. */
export const MAX_CONSECUTIVE_PROVIDER_ERRORS = 3;
const PROVIDER_FAILURES = new Set(['error', 'timeout']);

/**
 * Threshold check on the whole run. A ceiling (op <=, e.g. unsupported_items <= 0) counts what is wrong in the outputs:
 * a case without output has nothing to count, so it cannot pass while any case gave no output, nor after an aborted run.
 */
export function checkThresholds(thresholds: Threshold[], metrics: Record<string, number>, aborted: boolean) {
  const missing = (metrics.cases_without_output ?? 0) > 0;
  return thresholds.map(t => {
    const actual = metrics[t.metric];
    const blocked = aborted || (t.op === '<=' && missing);
    return { ...t, actual: actual ?? null, pass: !blocked && compare(t, actual),
      ...(blocked ? { note: aborted ? 'run aborted' : `${metrics.cases_without_output} case(s) without output: nothing measured there` } : {}) };
  });
}

export interface CredibilityEvidence {
  format: string;
  task_type: string; model: string; prompt_id: string; prompt_version: number; credibility_plan: string;
  provider: string; mode: 'live' | 'replay'; dry_run: boolean; run_at: string;
  dataset: { dir: string; dataset_id: string; version: string; kind: string; sha256: string; provenance: DatasetManifest['provenance'] };
  counts_as_evidence: boolean;
  evidence_problems: string[];
  cases: CaseScore[];
  metrics: Record<string, number>;
  thresholds: (Threshold & { actual: number | null; pass: boolean; note?: string })[];
  aborted: boolean;                    // stopped after MAX_CONSECUTIVE_PROVIDER_ERRORS: the remaining cases were not run
  thresholds_met: boolean;
  passed: boolean;
}

const SCORERS: Record<string, { score: typeof scoreAppendix; metrics: typeof appendixMetrics }> = {
  'protocol.appendix.draft': { score: scoreAppendix, metrics: appendixMetrics },
};

export async function runCredibility(opts: { task_type: string; datasetDir: string; provider: Provider; dryRun?: boolean;
  registry?: Record<string, TaskTypeDef>; promptAuthors?: string[]; maxConsecutiveErrors?: number }): Promise<CredibilityEvidence> {
  const def = (opts.registry ?? REGISTRY)[opts.task_type];
  if (!def) throw new Error(`task_type ${opts.task_type} is not registered`);
  const scorer = SCORERS[opts.task_type];
  if (!scorer) throw new Error(`no credibility scorer for ${opts.task_type} yet`);
  const ds = readCredibilityDataset(opts.datasetDir);
  const promptAuthors = opts.promptAuthors
    ?? readPromptLock().prompts[def.prompt_id]?.versions.find(v => v.version === def.prompt_version)?.authored_by ?? [];
  const mode = opts.provider.name === 'replay' ? 'replay' : 'live';
  const dryRun = opts.dryRun === true;

  // Capture the raw answer: the metrics are computed on what the model said, also when the runtime refused it.
  let raw: unknown = null;
  const capturing: Provider = { ...opts.provider, call: async c => { raw = null; const r = await opts.provider.call(c); raw = r.output; return r; } };
  const rt = createAiRuntime({ provider: capturing, registry: { [def.task_type]: def } });
  const db = { query: async () => ({ rows: [{ id: 'credibility' }] }) };   // evaluation runs are evidence, not ledger rows
  const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats.default(ajv);
  const validate = ajv.compile(def.output_schema);
  const cases: CaseScore[] = [];
  const maxErrors = opts.maxConsecutiveErrors ?? MAX_CONSECUTIVE_PROVIDER_ERRORS;
  let streak = 0; let aborted = false;
  for (const { case: c } of ds.cases) {
    if (streak >= maxErrors) { aborted = true; break; }
    raw = null;
    const r = await rt.run({ task_type: def.task_type, data_class: c.data_class, input: c.input }, { db });
    const output = raw as Out | null;
    const schemaValid = output !== null && validate(output) === true;
    cases.push(scorer.score(def, c, schemaValid ? output : null, schemaValid, r.outcome, r.error));
    streak = PROVIDER_FAILURES.has(r.outcome) ? streak + 1 : 0;
  }
  const metrics = scorer.metrics(cases);
  const thresholds = checkThresholds(def.thresholds, metrics, aborted);
  const problems = provenanceProblems(ds, def, promptAuthors);
  if (aborted) problems.push(`aborted after ${maxErrors} consecutive provider errors: ${cases.length} of ${ds.cases.length} cases run (${cases.at(-1)?.error ?? ''})`.slice(0, 500));
  if (mode !== 'live') problems.push('replay provider: a dry run of the harness, it says nothing about the model');
  if (dryRun) problems.push('dry run');
  const thresholds_met = thresholds.every(t => t.pass);
  return {
    format: EVIDENCE_FORMAT,
    task_type: def.task_type, model: def.model, prompt_id: def.prompt_id, prompt_version: def.prompt_version,
    credibility_plan: def.credibility_plan, provider: opts.provider.name, mode, dry_run: dryRun, run_at: new Date().toISOString(),
    dataset: { dir: ds.dir, dataset_id: ds.manifest.dataset_id, version: ds.manifest.version, kind: ds.manifest.kind,
      sha256: datasetSha256(ds.cases), provenance: ds.manifest.provenance },
    counts_as_evidence: problems.length === 0, evidence_problems: problems,
    cases, metrics, thresholds, thresholds_met, aborted, passed: thresholds_met && problems.length === 0,
  };
}
