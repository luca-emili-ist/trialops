// Demo agents (spec §9 catalogue): Protocol author (CONFIRM, GxP proposal) and Onboarding planner (AUTO, non-GxP tasks).
// An agent works only on a task assigned to it, through the AI runtime, and leaves GxP outcomes in waiting_review.
import type { Db, Row } from '../db.ts';
import type { Services } from '../route.ts';
import { HttpError } from '../errors.ts';
import { agentClaims, asActor } from './identity.ts';
import { getVersion, approvedVersion, PROTOCOL_KINDS } from '../routes/protocol.ts';

export const AGENTS = { protocolAuthor: 'protocol-author', onboardingPlanner: 'onboarding-planner' } as const;

async function setState(db: Db, taskId: string, state: string, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = Object.keys(extra);
  await db.query(`update core.task set state = $2${cols.map((c, i) => `, ${c} = $${i + 3}`).join('')} where id = $1`,
    [taskId, state, ...cols.map(c => (typeof extra[c] === 'object' && extra[c] !== null ? JSON.stringify(extra[c]) : extra[c]))]);
}

async function protocolAuthor(db: Db, services: Services, task: Row): Promise<Row> {
  const k = PROTOCOL_KINDS.APPENDIX;
  const appendix = await getVersion(db, k, task.inputs.appendix_version_id);
  if (!appendix) throw new HttpError(422, 'missing_appendix', 'appendix draft not found for the task');
  const master = await approvedVersion(db, PROTOCOL_KINDS.MASTER, task.platform_id);
  const arm = (await db.query(`select a.code, a.name, a.intervention_type, a.has_prior_human_data, a.approved_any_indication, o.name sponsor
    from core.arm a left join core.organization o on o.id = a.sponsor_org_id where a.id = $1`, [task.arm_id])).rows[0];
  const r = await services.ai!.run({ task_type: 'protocol.appendix.draft', data_class: 'CONFIDENTIAL_SPONSOR', platform_id: task.platform_id,
    arm_id: task.arm_id, task_id: task.id,
    input: { master_protocol: master?.usdm ?? {}, arm, sponsor_documents: task.inputs.sponsor_documents ?? [] } }, { db });
  if (r.outcome !== 'success') {
    await setState(db, task.id, 'in_progress', { outputs: { ai_request_id: r.ai_request_id, outcome: r.outcome, error: r.error ?? null } });
    return { outcome: r.outcome, ai_request_id: r.ai_request_id, error: r.error };
  }
  // GxP: the draft is a proposal. It stays in the task until a person accepts it (AI-05, APP-TK-04).
  await setState(db, task.id, 'waiting_review', { outputs: { ai_request_id: r.ai_request_id, proposal: r.output } });
  return { outcome: r.outcome, ai_request_id: r.ai_request_id };
}

async function onboardingPlanner(db: Db, services: Services, task: Row): Promise<Row> {
  const arm = (await db.query('select code, name, intervention_type from core.arm where id = $1', [task.arm_id])).rows[0];
  const sites = (await db.query(`select s.id, s.site_number, o.name from core.site s join core.organization o on o.id = s.org_id
    where s.platform_id = $1 and s.status = 'active' order by s.site_number`, [task.platform_id])).rows;
  const r = await services.ai!.run({ task_type: 'arm.onboarding.plan', data_class: 'INTERNAL', platform_id: task.platform_id,
    arm_id: task.arm_id, task_id: task.id,
    input: { arm, sites: sites.map(s => ({ site_number: s.site_number, name: s.name })), today: new Date().toISOString().slice(0, 10) } }, { db });
  if (r.outcome !== 'success') {
    await setState(db, task.id, 'in_progress', { outputs: { ai_request_id: r.ai_request_id, outcome: r.outcome, error: r.error ?? null } });
    return { outcome: r.outcome, ai_request_id: r.ai_request_id, error: r.error };
  }
  const plan = r.output as { tasks: Row[]; checklist: Row[] };
  const siteBy = new Map(sites.map(s => [s.site_number, s.id]));
  const created: string[] = [];
  for (const t of plan.tasks) {
    // AUTO mode: operational tasks are created directly, assigned to roles; GxP ones are done and signed by people.
    created.push((await db.query(`insert into core.task(platform_id, arm_id, site_id, type, title, subject_ref, assignee_kind, assignee,
        gxp_impact, requires_signature, inputs, state, due_at, priority)
      values ($1,$2,$3,$4,$5,$6,'role',$7,$8,$8,$9,'assigned', clock_timestamp() + make_interval(days => $10), 'normal') returning id`,
      [task.platform_id, task.arm_id, siteBy.get(t.site_number) ?? null, t.type, t.title, `arm/${task.arm_id}`, t.assignee_role,
       t.gxp_impact, JSON.stringify({ source: 'agent:onboarding-planner', plan_task_id: task.id, key: t.key, area: t.area,
         depends_on: t.depends_on, ai_request_id: r.ai_request_id }), t.due_in_days])).rows[0].id);
  }
  await setState(db, task.id, 'completed', { outputs: { ai_request_id: r.ai_request_id, checklist: plan.checklist, created_task_ids: created } });
  return { outcome: r.outcome, ai_request_id: r.ai_request_id, tasks_created: created.length };
}

const RUNNERS = { [AGENTS.protocolAuthor]: protocolAuthor, [AGENTS.onboardingPlanner]: onboardingPlanner } as Record<string,
  (db: Db, services: Services, task: Row) => Promise<Row>>;

/** The task an agent can run now, or the reason why not (checked again by the worker before running). */
export async function runnableAgentTask(db: Db, services: Services, taskId: string): Promise<{ task: Row; agentId: string }> {
  if (!services.ai) throw new HttpError(501, 'ai_unavailable', 'AI runtime not configured');
  const task = (await db.query('select * from core.task where id = $1', [taskId])).rows[0];
  if (!task) throw new HttpError(404, 'not_found', 'task not found');
  if (task.assignee_kind !== 'agent') throw new HttpError(409, 'not_an_agent_task', 'task is not assigned to an agent');
  if (!['assigned', 'in_progress'].includes(task.state)) throw new HttpError(409, 'task_not_runnable', `task is ${task.state}`);
  const agentId = String(task.assignee).replace(/^agent:/, '');
  if (!RUNNERS[agentId]) throw new HttpError(422, 'unknown_agent', `no agent ${task.assignee}`);
  return { task, agentId };
}

/** Runs the agent a task is assigned to, as that agent. */
export async function runAgentTask(db: Db, services: Services, taskId: string): Promise<Row> {
  const { task, agentId } = await runnableAgentTask(db, services, taskId);
  const run = RUNNERS[agentId]!;
  return asActor(db, agentClaims(agentId, task.platform_id, task.arm_id), async () => {
    if (task.state === 'assigned') await setState(db, task.id, 'in_progress', { claimed_by: `agent:${agentId}`, claimed_at: new Date().toISOString() });
    return { task_id: task.id, agent: `agent:${agentId}`, ...(await run(db, services, task)) };
  });
}
