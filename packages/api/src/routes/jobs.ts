// AI jobs (0014): AI tasks and agent runs are recorded first as a job (queued), handed to a worker (Netlify: the
// background function ai-worker-background, up to 15 minutes; locally: this process) and polled by the client.
// The worker runs the job as the person who asked for it (same claims, RLS and audit), the agent under its own
// identity (IAM-07), and the model call is written to the ledger by the AI runtime as before (AI-01, AI-06).
import { route, type Ctx, type RawResponse } from '../route.ts';
import type { Db, Row } from '../db.ts';
import { HttpError, toHttp } from '../errors.ts';
import { runAgentTask } from '../agents/index.ts';
import type { AiTaskRequest } from '@trialops/ai-runtime';

export const JOB_COLS = `id, kind, status, platform_id, arm_id, task_id, result, error, ai_request_id, requested_by, max_execution_s,
  deadline_at, started_at, finished_at, created_at, updated_at`;
/** A worker that started more than this long ago has been stopped by the platform (15 min) without recording an end. */
const WORKER_LIMIT = '16 minutes';

type JobCtx = Pick<Ctx, 'tx' | 'services' | 'claims' | 'headers' | 'afterCommit'>;

/** Jobs past their limit are closed as failed (AI-09): queued past the deadline, or running after the worker limit. */
async function expire(db: Db, id: string): Promise<void> {
  await db.query(`update core.ai_job set status = 'failed', error = case when status = 'queued'
      then 'not started within max_execution_time (AI-09)' else 'worker stopped before finishing: max_execution_time exceeded (AI-09)' end
    where id = $1 and ((status = 'queued' and deadline_at < clock_timestamp())
      or (status = 'running' and started_at < clock_timestamp() - interval '${WORKER_LIMIT}'))`, [id]);
}

export async function getJob(db: Db, id: string): Promise<Row | undefined> {
  await expire(db, id);
  return (await db.query(`select ${JOB_COLS} from core.ai_job where id = $1`, [id])).rows[0];
}

/** Records the job (status queued) in the request transaction and dispatches it once that transaction committed. */
export async function enqueueJob(ctx: JobCtx & { db: Db }, job: { kind: 'ai_task' | 'agent_run'; request: Row;
  platform_id?: string | null; arm_id?: string | null; task_id?: string | null }): Promise<RawResponse> {
  const ins = (await ctx.db.query(`insert into core.ai_job(kind, request, platform_id, arm_id, task_id) values ($1,$2,$3,$4,$5)
      on conflict (task_id) where kind = 'agent_run' and status in ('queued','running') do nothing returning ${JOB_COLS}`,
    [job.kind, JSON.stringify(job.request), job.platform_id ?? null, job.arm_id ?? null, job.task_id ?? null])).rows[0];
  // a second request for an agent already queued or running gets the same job, not a second run
  const row = ins ?? (await ctx.db.query(`select ${JOB_COLS} from core.ai_job where task_id = $1 and kind = 'agent_run'
    and status in ('queued','running')`, [job.task_id])).rows[0]!;
  if (ins) ctx.afterCommit(() => dispatch(ctx, row.id));
  return { status: 202, headers: { location: `/v1/ai/jobs/${row.id}` }, body: row };
}

async function dispatch(ctx: JobCtx, id: string): Promise<void> {
  if (!ctx.services.jobs) {
    // local development and tests: run in this process after the response, the client polls like in production
    setImmediate(() => { executeJob(ctx, id).catch(e => console.error(`AI job ${id}`, e)); });
    return;
  }
  try {
    await ctx.services.jobs.dispatch(id, { authorization: ctx.headers.authorization, cookie: ctx.headers.cookie });
  } catch (e) {
    const message = `dispatch to the worker failed: ${(e as Error).message}`;
    await ctx.tx(db => db.query("update core.ai_job set status = 'failed', error = $2 where id = $1 and status = 'queued'", [id, message]));
    throw new HttpError(502, 'dispatch_failed', message);
  }
}

/** Worker side: claims the queued job, runs it in its own transaction and records the outcome. Idempotent. */
export async function executeJob(ctx: Pick<Ctx, 'tx' | 'services'>, id: string): Promise<Row | undefined> {
  const claimed = await ctx.tx(async db => {
    await expire(db, id);
    return (await db.query("update core.ai_job set status = 'running' where id = $1 and status = 'queued' returning id, kind, request, task_id",
      [id])).rows[0];
  });
  if (!claimed) return ctx.tx(db => getJob(db, id));   // already taken, finished, expired, or not this caller's job
  try {
    return await ctx.tx(async db => {
      let result: Row;
      if (claimed.kind === 'agent_run') {
        result = await runAgentTask(db, ctx.services, claimed.task_id);
      } else {
        if (!ctx.services.ai) throw new HttpError(501, 'ai_unavailable', 'AI runtime not configured');
        result = { ...(await ctx.services.ai.run(claimed.request as AiTaskRequest, { db })) };
      }
      return (await db.query(`update core.ai_job set status = 'completed', result = $2, ai_request_id = $3 where id = $1 returning ${JOB_COLS}`,
        [id, JSON.stringify(result), result.ai_request_id ?? null])).rows[0];
    });
  } catch (e) {
    // the work rolled back as a whole (no half-done task); the job keeps the reason
    const h = toHttp(e);
    if (h.status >= 500) console.error(`AI job ${id}`, e);
    return ctx.tx(async db => (await db.query(`update core.ai_job set status = 'failed', error = $2 where id = $1 and status = 'running'
      returning ${JOB_COLS}`, [id, `${h.code}: ${h.message}`])).rows[0] ?? getJob(db, id));
  }
}

export const jobRoutes = [
  route({ method: 'get', path: '/v1/ai/jobs/:id', summary: 'State of an AI job (poll until completed or failed)', tag: 'ai',
    reqs: ['AI-01', 'AI-09'],
    handler: async ({ db, params }) => getJob(db, params.id!) }),

  route({ method: 'post', path: '/v1/ai/jobs/:id/execute', manualTx: true, tag: 'ai', reqs: ['AI-01', 'AI-09'],
    summary: 'Worker entry point: run a queued job as the person who asked for it (called by the background function)',
    handler: async ctx => {
      if (!/^[0-9a-f-]{36}$/.test(ctx.params.id!)) throw new HttpError(400, 'invalid_input', 'job id must be a uuid');
      return executeJob(ctx, ctx.params.id!);
    } }),
];
