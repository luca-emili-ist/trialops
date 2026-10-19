// AI entry point (AI-01): POST /api/ai/tasks. Callers send an intent; the runtime picks the pinned model, applies the
// data-class policy and records the call in the ledger (AI-06) as the caller (RLS applies). The call runs as a job
// (0014) so that a long model call never depends on the time limit of a synchronous HTTP function.
import { route, uuid } from '../route.ts';
import { HttpError } from '../errors.ts';
import { enqueueJob } from './jobs.ts';
import { DATA_CLASSES } from '@trialops/ai-runtime';
import type { AiTaskRequest, TaskTypeDef } from '@trialops/ai-runtime';
import type { Ctx } from '../route.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { monitorTaskType, breachReason } from '../lib/ai-monitoring.ts';
import { signerOf } from '../lib/policy-engine.ts';

/** Platform of a monitoring call: the one asked for, or the only platform of the token. */
function monitoringPlatform(ctx: Ctx<unknown>, asked: string | undefined): string {
  if (asked) return asked;
  const mine = ctx.claims.platform_ids ?? [];
  if (mine.length === 1) return mine[0]!;
  throw new HttpError(400, 'platform_required', 'platform_id is required (the token covers several platforms)');
}
function registryOf(ctx: Ctx<unknown>): Record<string, TaskTypeDef> {
  if (!ctx.services.ai) throw new HttpError(501, 'ai_unavailable', 'AI runtime not configured');
  return ctx.services.ai.registry;
}
const monitoringReaders = ['qa_auditor', 'platform_admin'] as const;

export const aiRoutes = [
  route<AiTaskRequest>({ method: 'post', path: '/api/ai/tasks', raw: true, provenance: false, tag: 'ai', reqs: ['AI-01', 'AI-06', 'AI-09'],
    summary: 'Queue an AI task for the AI runtime: 202 with the job, poll GET /v1/ai/jobs/{id} for the outcome',
    body: { type: 'object', additionalProperties: false, required: ['task_type', 'data_class', 'input'],
      properties: { task_type: { type: 'string' }, data_class: { enum: DATA_CLASSES }, input: { type: 'object' },
        platform_id: uuid, arm_id: uuid, task_id: uuid } },
    handler: async ctx => {
      if (!ctx.services.ai) throw new HttpError(501, 'ai_unavailable', 'AI runtime not configured');
      ctx.services.ai.check(ctx.body);   // unknown task types and unapproved data classes are refused before queueing
      return enqueueJob(ctx, { kind: 'ai_task', request: ctx.body, platform_id: ctx.body.platform_id, arm_id: ctx.body.arm_id,
        task_id: ctx.body.task_id });
    } }),

  route({ method: 'get', path: '/v1/ai/task-types', summary: 'Registered AI task types with model, prompt version and risk', tag: 'ai',
    reqs: ['AI-01', 'AI-02'],
    handler: async ({ services }) => ({
      items: Object.values(services.ai?.registry ?? {}).map(d => ({ task_type: d.task_type, intended_use: d.intended_use, risk: d.risk,
        gxp: d.gxp, category: d.category, model: d.model, effort: d.effort, max_tokens: d.max_tokens, prompt_id: d.prompt_id,
        prompt_version: d.prompt_version, data_classes: d.data_classes, credibility_plan: d.credibility_plan, dataset: d.dataset,
        thresholds: d.thresholds, monitoring: d.monitoring, citation: d.citation ?? null })),
      provider: services.ai?.provider.name ?? null,
    }) }),

  route({ method: 'get', path: '/v1/platforms/:id/ai-requests', summary: 'AI ledger of a platform', tag: 'ai', reqs: ['AI-06'],
    handler: async ({ db, params }) => ({
      items: (await db.query(`select id, arm_id, task_id, task_type, data_class, provider, model, model_version, prompt_id, prompt_version,
          input_sha256, output_sha256, input_tokens, output_tokens, cost_eur, latency_ms, outcome, review_decision, reviewer_sub,
          requested_by, created_at
        from core.ai_request where platform_id = $1 order by created_at desc limit 200`, [params.id])).rows,
    }) }),

  route({ method: 'get', path: '/v1/ai/monitoring', tag: 'ai', reqs: ['AI-10', 'AI-08'],
    summary: 'Monitoring per AI task type on a platform: review outcomes, validation failures, drift, rules and mode (normal or suggestion-only)',
    query: { platform_id: uuid },
    handler: async ctx => {
      requireRole(ctx.claims, [...monitoringReaders], 'Reading the AI monitoring');
      const platform = monitoringPlatform(ctx, ctx.query.platform_id);
      const items = [];
      for (const def of Object.values(registryOf(ctx))) items.push(await monitorTaskType(ctx.db, platform, def));
      // AI-08: unsigned Agent Decision Records (no signing key configured) are an anomaly to act on, never hidden.
      const s = signerOf(ctx.services);
      const d = (await ctx.db.query(`select count(*)::int total, count(*) filter (where signature_status = 'unsigned')::int unsigned
        from core.agent_decision_record where platform_id = $1`, [platform])).rows[0]!;
      const anomalies = [
        ...(s.mode === 'unsigned' ? ['decision signing key not configured: new Agent Decision Records are unsigned (AI-08)'] : []),
        ...(d.unsigned > 0 ? [`${d.unsigned} unsigned Agent Decision Record(s) on this platform (AI-08)`] : []),
      ];
      return { platform_id: platform, items, decision_records: { ...d, signer: { mode: s.mode, key_id: s.keyId }, anomalies } };
    } }),

  route<{ platform_id?: string }>({ method: 'post', path: '/v1/ai/monitoring/evaluate', tag: 'ai', reqs: ['AI-10'],
    summary: 'Recompute the monitoring and send every task type whose rules are crossed to suggestion-only (never back to normal)',
    body: { type: 'object', additionalProperties: false, properties: { platform_id: uuid } },
    handler: async ctx => {
      requirePerson(ctx.claims, 'Evaluating the AI monitoring');
      requireRole(ctx.claims, ['platform_admin'], 'Evaluating the AI monitoring');
      const platform = monitoringPlatform(ctx, ctx.body?.platform_id);
      const items = []; const switched: string[] = [];
      for (const def of Object.values(registryOf(ctx))) {
        let m = await monitorTaskType(ctx.db, platform, def);
        if (m.breach && m.mode === 'normal') {
          await ctx.db.query('select core.ai_task_type_set_mode($1, $2, $3, $4, $5, $6)',
            [platform, def.task_type, 'suggestion_only', breachReason(m), JSON.stringify({ metrics: m.metrics, rules: m.rules, drift: m.drift }), 'evaluation']);
          switched.push(def.task_type);
          m = await monitorTaskType(ctx.db, platform, def);
        }
        items.push(m);
      }
      return { platform_id: platform, switched, items };
    } }),

  route<{ platform_id?: string; task_type: string; mode: 'normal' | 'suggestion_only' }>({ method: 'post', path: '/v1/ai/monitoring/mode',
    tag: 'ai', reqs: ['AI-10'], needsReason: true,
    summary: 'Explicit decision of a platform admin on the mode of an AI task type (the only way back to normal), with a reason',
    body: { type: 'object', additionalProperties: false, required: ['task_type', 'mode'],
      properties: { platform_id: uuid, task_type: { type: 'string', maxLength: 100 }, mode: { enum: ['normal', 'suggestion_only'] } } },
    handler: async ctx => {
      requirePerson(ctx.claims, 'Changing the mode of an AI task type');
      requireRole(ctx.claims, ['platform_admin'], 'Changing the mode of an AI task type');
      const def = registryOf(ctx)[ctx.body.task_type];
      if (!def) throw new HttpError(422, 'unknown_task_type', `task_type ${ctx.body.task_type} is not registered (AI-02)`);
      const platform = monitoringPlatform(ctx, ctx.body.platform_id);
      const before = await monitorTaskType(ctx.db, platform, def);
      await ctx.db.query('select core.ai_task_type_set_mode($1, $2, $3, $4, $5, $6)',
        [platform, def.task_type, ctx.body.mode, ctx.reason, JSON.stringify({ metrics: before.metrics, rules: before.rules, drift: before.drift }), 'manual']);
      return monitorTaskType(ctx.db, platform, def);
    } }),
];
