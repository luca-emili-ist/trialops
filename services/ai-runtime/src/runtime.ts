// AI runtime (ARC-10): POST /api/ai/tasks. Resolves the task type, applies the data-class policy, calls the pinned
// model through a provider with the fixed generation parameters of the registry (AI-04), validates the structured output
// against the JSON Schema and the mandatory source citation (AI-04) and writes one ledger row per call (AI-06).
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import Anthropic from '@anthropic-ai/sdk';
import { REGISTRY, type TaskTypeDef } from './registry.ts';
import { canonical, sha256 } from './canonical.ts';
import { checkCitations, citationError } from './citation.ts';
import { anthropicProvider } from './providers/anthropic.ts';
import { replayProvider, recording } from './providers/replay.ts';
import type { AiTaskRequest, AiTaskResult, DataClass, LedgerDb, Outcome, Provider } from './types.ts';

/** USD per million tokens (list price). Ledger cost is in EUR at TRIALOPS_USD_EUR. */
export const PRICE_USD_PER_MTOK: Record<string, { in: number; out: number }> = { 'claude-opus-5-5': { in: 4, out: 20 } };

export class AiRequestError extends Error {
  readonly status = 422;
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface AiRuntimeOptions {
  provider?: Provider;
  /** Data region of the deployment (NFR-06); default TRIALOPS_DEPLOYMENT_REGION. */
  region?: string | null;
  /** Code of the AI provider in the service provider registry (core.service_provider, CMP-08); default TRIALOPS_AI_PROVIDER_CODE. */
  providerCode?: string | null;
  registry?: Record<string, TaskTypeDef>;
  usdToEur?: number;
  now?: () => number;
}

/** Provider from the environment: TRIALOPS_AI_MODE=live (Anthropic, needs ANTHROPIC_API_KEY) or replay (default). */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): Provider {
  if (env.TRIALOPS_AI_MODE !== 'live') return replayProvider();
  // One model call must end well inside the AI job limit (0014: 14 min, worker 15 min): bounded timeout and one retry.
  const live = anthropicProvider(new Anthropic({ timeout: Number(env.TRIALOPS_AI_TIMEOUT_MS || 360_000), maxRetries: 1 }));
  return env.TRIALOPS_AI_RECORD === '1' ? recording(live) : live;
}

/** Data class of a request -> category of the service provider registry (0026). PUBLIC data is not restricted. */
const PROVIDER_CATEGORY: Partial<Record<DataClass, string>> = {
  INTERNAL: 'operational', CONFIDENTIAL_SPONSOR: 'sponsor_confidential', CLINICAL_PSEUDONYMIZED: 'pseudonymised_clinical',
};

export function createAiRuntime(opts: AiRuntimeOptions = {}) {
  const provider = opts.provider ?? providerFromEnv();
  const region = (opts.region !== undefined ? opts.region : process.env.TRIALOPS_DEPLOYMENT_REGION?.trim().toUpperCase()) || null;
  const providerCode = (opts.providerCode !== undefined ? opts.providerCode : process.env.TRIALOPS_AI_PROVIDER_CODE?.trim()) || null;
  const registry = opts.registry ?? REGISTRY;
  const usdToEur = opts.usdToEur ?? Number(process.env.TRIALOPS_USD_EUR || 0.86);
  const now = opts.now ?? (() => performance.now());
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validators = new Map<string, ValidateFunction>();
  const validatorFor = (d: TaskTypeDef) => {
    let v = validators.get(d.task_type);
    if (!v) { v = ajv.compile(d.output_schema); validators.set(d.task_type, v); }
    return v;
  };

  async function ledger(db: LedgerDb, req: AiTaskRequest, d: TaskTypeDef, row: {
    model: string; input_sha256: string; output_sha256: string | null; input_tokens: number | null; output_tokens: number | null;
    latency_ms: number | null; outcome: Outcome; validation_error?: string;
  }): Promise<string> {
    const price = PRICE_USD_PER_MTOK[row.model];
    const cost = price && row.input_tokens !== null && row.output_tokens !== null
      ? ((row.input_tokens * price.in + row.output_tokens * price.out) / 1e6) * usdToEur : 0;
    const r = await db.query(`insert into core.ai_request(platform_id, arm_id, task_id, task_type, data_class, provider, model, model_version,
        prompt_id, prompt_version, input_sha256, output_sha256, input_tokens, output_tokens, cost_eur, latency_ms, outcome, validation_error)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
      [req.platform_id ?? null, req.arm_id ?? null, req.task_id ?? null, d.task_type, req.data_class, provider.name, d.model, row.model,
       d.prompt_id, d.prompt_version, row.input_sha256, row.output_sha256, row.input_tokens, row.output_tokens,
       Math.round(cost * 1e6) / 1e6, row.latency_ms, row.outcome, row.validation_error?.slice(0, 2000) ?? null]);
    return String(r.rows[0]!.id);
  }

  /** Refuses unregistered task types and unapproved data classes before anything is queued or called (AI-01, AI-02). */
  function check(req: Pick<AiTaskRequest, 'task_type' | 'data_class'>): TaskTypeDef {
    const d = registry[req.task_type];
    if (!d) throw new AiRequestError('unknown_task_type', `task_type ${req.task_type} is not registered (AI-02)`);
    if (!d.data_classes.includes(req.data_class)) {
      throw new AiRequestError('data_class_not_allowed', `${req.task_type} is not approved for ${req.data_class} data`);
    }
    return d;
  }

  /**
   * NFR-06 / CMP-08: data of a platform goes to an external AI provider only when that provider is registered, active on
   * the platform for this data category, processes in the platform region and has its agreements (core.provider_allowed).
   * Returns the reason of a refusal, or null.
   */
  async function residencyRefusal(db: LedgerDb, req: AiTaskRequest): Promise<string | null> {
    if (provider.local) return null;
    const category = PROVIDER_CATEGORY[req.data_class];
    if (!category || !req.platform_id) return null;
    if (!providerCode) {
      return region ? `the AI provider ${provider.name} is not registered as a service provider of the ${region} deployment ` +
        '(TRIALOPS_AI_PROVIDER_CODE, NFR-06)' : null;
    }
    const ok = (await db.query('select core.provider_allowed($1, $2, $3) ok', [req.platform_id, providerCode, category])).rows[0]?.ok === true;
    return ok ? null : `${category} data of this platform may not go to provider ${providerCode}: not active on the platform for it, ` +
      'outside the platform data region or without a valid agreement (NFR-06, CMP-08)';
  }

  return {
    provider,
    registry,
    region,
    providerCode,
    check,
    async run(req: AiTaskRequest, caller: { db: LedgerDb }): Promise<AiTaskResult> {
      const d = check(req);
      const prompt = d.render(req.input);
      const input_sha256 = sha256(canonical({ task_type: d.task_type, prompt_id: d.prompt_id, prompt_version: d.prompt_version,
        model: d.model, system: prompt.system, user: prompt.user }));
      const base = { model: d.model, input_sha256, output_sha256: null, input_tokens: null, output_tokens: null, latency_ms: null };
      const result = (outcome: Outcome, id: string, output: Record<string, unknown> | null, model: string, error?: string): AiTaskResult =>
        ({ ai_request_id: id, outcome, output, provider: provider.name, model, ...(error ? { error } : {}) });

      if (!provider.accepts.includes(req.data_class)) {
        const id = await ledger(caller.db, req, d, { ...base, outcome: 'blocked' });
        return result('blocked', id, null, d.model, `${req.data_class} data may not be sent to ${provider.name}`);
      }
      const refusal = await residencyRefusal(caller.db, req);
      if (refusal) {
        const id = await ledger(caller.db, req, d, { ...base, outcome: 'blocked' });   // reason in the job result
        return result('blocked', id, null, d.model, refusal);
      }
      const t0 = now();
      let r;
      try {
        // AI-04: only registry values and the rendered prompt reach the provider; nothing of the request chooses parameters.
        r = await provider.call({ task_type: d.task_type, model: d.model, effort: d.effort, max_tokens: d.max_tokens, system: prompt.system,
          user: prompt.user, output_schema: d.output_schema, input_sha256 });
      } catch (e) {
        const timeout = (e as { name?: string })?.name?.includes('Timeout');
        const id = await ledger(caller.db, req, d, { ...base, latency_ms: Math.round(now() - t0), outcome: timeout ? 'timeout' : 'error' });
        return result(timeout ? 'timeout' : 'error', id, null, d.model, (e as Error).message);
      }
      const usage = { model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens, latency_ms: Math.round(now() - t0) };
      // AI-03: the provider must answer with the pinned model. Any other id (alias moved, silent upgrade, fallback) is
      // recorded and refused: a model change goes through change control, never through the provider.
      if (r.model !== d.model) {
        const id = await ledger(caller.db, req, d, { ...base, ...usage, outcome: 'blocked' });
        return result('blocked', id, null, r.model, `model drift: ${d.task_type} is pinned to ${d.model}, provider answered with ${r.model} (AI-03)`);
      }
      if (r.refusal) {
        const id = await ledger(caller.db, req, d, { ...base, ...usage, outcome: 'blocked' });
        return result('blocked', id, null, r.model, `provider declined (${r.refusal})`);
      }
      const output_sha256 = sha256(canonical(r.output));
      const validate = validatorFor(d);
      if (!validate(r.output)) {
        const error = ajv.errorsText(validate.errors);
        const id = await ledger(caller.db, req, d, { ...base, ...usage, output_sha256, outcome: 'validation_failed', validation_error: `schema: ${error}` });
        return result('validation_failed', id, null, r.model, error);
      }
      // The answer the platform sees: normalised after validation (prompt v2: per-item sources → `sources` list).
      const output = d.normalise ? d.normalise(r.output) : r.output as Record<string, unknown>;
      // A collapsed answer (placeholders instead of content) is refused visibly, never passed on (CR-AI-0001).
      const fillers = d.placeholders ? d.placeholders(output) : [];
      if (fillers.length) {
        const error = `placeholder answer refused: ${fillers.slice(0, 6).join('; ')}${fillers.length > 6 ? `; and ${fillers.length - 6} more` : ''}`;
        const id = await ledger(caller.db, req, d, { ...base, ...usage, output_sha256, outcome: 'validation_failed', validation_error: `placeholder: ${error}` });
        return result('validation_failed', id, null, r.model, error);
      }
      // AI-04: extraction and classification outputs must cite their sources verbatim; otherwise they never reach a person.
      if (d.citation) {
        const report = checkCitations(d.citation, req.input, output);
        if (report.errors.length) {
          const error = citationError(report);
          const id = await ledger(caller.db, req, d, { ...base, ...usage, output_sha256, outcome: 'validation_failed', validation_error: `citation: ${error}` });
          return result('validation_failed', id, null, r.model, error);
        }
      }
      const id = await ledger(caller.db, req, d, { ...base, ...usage, output_sha256, outcome: 'success' });
      return result('success', id, d.finalise ? d.finalise(output) : output, r.model);
    },
  };
}
export type AiRuntime = ReturnType<typeof createAiRuntime>;
