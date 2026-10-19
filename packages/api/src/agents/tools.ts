// Executors of the agent tools registered in core.ai_tool (AI-07, migration 0025). An agent never writes platform data
// itself: it asks the policy engine (lib/policy-engine.ts, invokeTool), which decides ALLOW / REVIEW / BLOCK, writes the
// signed Agent Decision Record (AI-08) and only on ALLOW runs the executor below (as the agent; or, for a pending action
// confirmed by a person, as that person). A registered tool without an executor here is always refused (AI08-NO-EXECUTOR):
// protocol.appendix.write is such a tool, GxP content is written only by people with a signature (AI-05).
import type { Db, Row } from '../db.ts';

export interface ToolContext {
  /** Sub of the person who confirmed a pending action (CONFIRM); absent when the agent runs the tool itself (AUTO). */
  confirmedBy?: string;
  pendingActionId?: string;
}

export interface ToolExecutor {
  execute(db: Db, args: Row, ctx: ToolContext): Promise<Row>;
  /** What a rejection by a person leaves behind (the task records the decision). */
  reject?(db: Db, args: Row, ctx: { decidedBy: string; pendingActionId: string }): Promise<void>;
}

async function reviewOutcome(db: Db, aiRequestId: string | undefined, decision: 'accepted' | 'rejected', sub: string): Promise<void> {
  if (aiRequestId) await db.query('update core.ai_request set review_decision = $2, reviewer_sub = $3 where id = $1', [aiRequestId, decision, sub]);
}

/** Creates the operational tasks of an onboarding plan, assigned to roles; GxP ones are done and signed by people. */
export async function createPlanTasks(db: Db, task: Row, plan: { tasks: Row[] }, aiRequestId: string): Promise<string[]> {
  const sites = (await db.query("select id, site_number from core.site where platform_id = $1 and status = 'active'", [task.platform_id])).rows;
  const siteBy = new Map(sites.map(s => [s.site_number, s.id]));
  const created: string[] = [];
  for (const t of plan.tasks) {
    created.push((await db.query(`insert into core.task(platform_id, arm_id, site_id, type, title, subject_ref, assignee_kind, assignee,
        gxp_impact, requires_signature, inputs, state, due_at, priority)
      values ($1,$2,$3,$4,$5,$6,'role',$7,$8,$8,$9,'assigned', clock_timestamp() + make_interval(days => $10), 'normal') returning id`,
      [task.platform_id, task.arm_id, siteBy.get(t.site_number) ?? null, t.type, t.title, `arm/${task.arm_id}`, t.assignee_role,
       t.gxp_impact, JSON.stringify({ source: 'agent:onboarding-planner', plan_task_id: task.id, key: t.key, area: t.area,
         depends_on: t.depends_on, ai_request_id: aiRequestId, assignee_role: t.assignee_role }), t.due_in_days])).rows[0].id);
  }
  return created;
}

export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  // The proposal of the Protocol author goes to the task for review and signature by a person (AI-05, APP-TK-04).
  'protocol.appendix.propose': {
    async execute(db, a, ctx) {
      const outputs = { ai_request_id: a.ai_request_id, proposal: a.proposal, monitoring_mode: a.monitoring_mode ?? 'normal',
        ...(ctx.confirmedBy ? { proposal_confirmed_by: ctx.confirmedBy, pending_action_id: ctx.pendingActionId } : {}) };
      await db.query("update core.task set state = 'waiting_review', outputs = $2 where id = $1", [a.task_id, JSON.stringify(outputs)]);
      return { task_id: a.task_id, state: 'waiting_review' };
    },
    async reject(db, a, ctx) {
      await db.query('update core.task set outputs = outputs || $2::jsonb where id = $1', [a.task_id,
        JSON.stringify({ proposal_rejected_by: ctx.decidedBy, pending_action_id: ctx.pendingActionId })]);
      await reviewOutcome(db, a.ai_request_id, 'rejected', ctx.decidedBy);
    },
  },
  // The Onboarding planner creates the operational tasks of its plan and closes its own task.
  'onboarding.tasks.create': {
    async execute(db, a, ctx) {
      const task = (await db.query('select id, platform_id, arm_id from core.task where id = $1', [a.task_id])).rows[0];
      if (!task) throw new Error(`task ${a.task_id} not found`);
      const plan = a.plan as { tasks: Row[]; checklist?: Row[] };
      const created = await createPlanTasks(db, task, plan, a.ai_request_id);
      if (ctx.confirmedBy) {
        await db.query("update core.task set outputs = outputs || $2::jsonb, state = 'completed' where id = $1", [task.id, JSON.stringify({
          decision: 'accepted', decided_by: ctx.confirmedBy, checklist: plan.checklist ?? [], created_task_ids: created,
          pending_action_id: ctx.pendingActionId })]);
        await reviewOutcome(db, a.ai_request_id, 'accepted', ctx.confirmedBy);
      } else {
        await db.query("update core.task set outputs = $2, state = 'completed' where id = $1", [task.id, JSON.stringify({
          ai_request_id: a.ai_request_id, checklist: plan.checklist ?? [], created_task_ids: created })]);
      }
      return { tasks_created: created.length, created_task_ids: created };
    },
    async reject(db, a, ctx) {
      const plan = a.plan as { checklist?: Row[] };
      await db.query("update core.task set outputs = outputs || $2::jsonb, state = 'rejected' where id = $1", [a.task_id, JSON.stringify({
        decision: 'rejected', decided_by: ctx.decidedBy, checklist: plan?.checklist ?? [], created_task_ids: [], pending_action_id: ctx.pendingActionId })]);
      await reviewOutcome(db, a.ai_request_id, 'rejected', ctx.decidedBy);
    },
  },
};
