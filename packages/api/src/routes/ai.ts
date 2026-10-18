// AI entry point (AI-01): POST /api/ai/tasks. Callers send an intent; the runtime picks the pinned model, applies the
// data-class policy and records the call in the ledger (AI-06) as the caller (RLS applies). The call runs as a job
// (0014) so that a long model call never depends on the time limit of a synchronous HTTP function.
import { route, uuid } from '../route.ts';
import { HttpError } from '../errors.ts';
import { enqueueJob } from './jobs.ts';
import { DATA_CLASSES } from '@trialops/ai-runtime';
import type { AiTaskRequest } from '@trialops/ai-runtime';

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
    reqs: ['AI-01'],
    handler: async ({ services }) => ({
      items: Object.values(services.ai?.registry ?? {}).map(d => ({ task_type: d.task_type, intended_use: d.intended_use, risk: d.risk,
        gxp: d.gxp, model: d.model, effort: d.effort, prompt_id: d.prompt_id, prompt_version: d.prompt_version, data_classes: d.data_classes })),
      provider: services.ai?.provider.name ?? null,
    }) }),

  route({ method: 'get', path: '/v1/platforms/:id/ai-requests', summary: 'AI ledger of a platform', tag: 'ai', reqs: ['AI-06'],
    handler: async ({ db, params }) => ({
      items: (await db.query(`select id, arm_id, task_id, task_type, data_class, provider, model, model_version, prompt_id, prompt_version,
          input_sha256, output_sha256, input_tokens, output_tokens, cost_eur, latency_ms, outcome, review_decision, reviewer_sub,
          requested_by, created_at
        from core.ai_request where platform_id = $1 order by created_at desc limit 200`, [params.id])).rows,
    }) }),
];
