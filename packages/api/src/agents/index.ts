// Demo agents (spec §9 catalogue): Protocol author (CONFIRM, GxP proposal) and Onboarding planner (AUTO, non-GxP tasks).
// An agent works only on a task assigned to it, through the AI runtime, and leaves GxP outcomes in waiting_review.
// AI-10: when monitoring has sent a task type to suggestion-only, the agent never acts on its output by itself: the
// Onboarding planner leaves its plan as a proposal for a person to confirm (POST /v1/tasks/{id}/confirm-plan).
// AI-07/AI-08: an agent acts on platform data only through a registered tool, via the policy engine (invokeTool), which
// decides ALLOW / REVIEW / BLOCK and writes the signed Agent Decision Record; REVIEW leaves a pending action for a person.
import type { Db, Row } from '../db.ts';
import type { Services } from '../route.ts';
import { HttpError } from '../errors.ts';
import { agentClaims, asActor } from './identity.ts';
import { getVersion, approvedVersion, PROTOCOL_KINDS } from '../routes/protocol.ts';
import { taskTypeMode } from '../lib/ai-monitoring.ts';
import { invokeTool, type ToolOutcome } from '../lib/policy-engine.ts';
import { createPlanTasks } from './tools.ts';

export { createPlanTasks };

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
  // GxP: the draft is a proposal. It stays in the task until a person accepts it (AI-05, APP-TK-04). In suggestion-only
  // mode (AI-10) the reviewer is told the task type is under closer watch.
  const mode = await taskTypeMode(db, task.platform_id, 'protocol.appendix.draft');
  const inv = await invokeTool(db, services, { agentId: AGENTS.protocolAuthor, tool: 'protocol.appendix.propose', platformId: task.platform_id,
    armId: task.arm_id, taskId: task.id, ai: { ai_request_id: r.ai_request_id, task_type: 'protocol.appendix.draft' },
    args: { task_id: task.id, ai_request_id: r.ai_request_id, proposal: r.output, monitoring_mode: mode } });
  if (inv.decision !== 'ALLOW') await holdOutput(db, task.id, r.ai_request_id, inv);
  return { outcome: inv.decision === 'BLOCK' ? 'blocked' : r.outcome, ai_request_id: r.ai_request_id, ...decisionOf(inv) };
}

const decisionOf = (inv: ToolOutcome) => ({ decision: inv.decision, decision_record_id: inv.decision_record_id,
  pending_action_id: inv.pending_action_id, rule_ids: inv.rule_ids });

/** The tool did not run: the task stays with the agent and says why (REVIEW: waiting for a person; BLOCK: refused). */
async function holdOutput(db: Db, taskId: string, aiRequestId: string, inv: ToolOutcome): Promise<void> {
  await setState(db, taskId, 'in_progress', { outputs: { ai_request_id: aiRequestId, ...decisionOf(inv),
    ...(inv.decision === 'BLOCK' ? { blocked: true } : { awaiting_confirmation: true }) } });
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
  const mode = await taskTypeMode(db, task.platform_id, 'arm.onboarding.plan');
  const inv = await invokeTool(db, services, { agentId: AGENTS.onboardingPlanner, tool: 'onboarding.tasks.create', platformId: task.platform_id,
    armId: task.arm_id, taskId: task.id, ai: { ai_request_id: r.ai_request_id, task_type: 'arm.onboarding.plan' },
    args: { task_id: task.id, ai_request_id: r.ai_request_id, plan } });
  if (inv.decision === 'ALLOW') {
    return { outcome: r.outcome, ai_request_id: r.ai_request_id, tasks_created: inv.result?.tasks_created ?? 0, ...decisionOf(inv) };
  }
  if (inv.decision === 'BLOCK') {
    await holdOutput(db, task.id, r.ai_request_id, inv);
    return { outcome: 'blocked', ai_request_id: r.ai_request_id, tasks_created: 0, ...decisionOf(inv) };
  }
  // REVIEW (AI-07 CONFIRM, or the AI-10 suggestion-only fallback): nothing is created; a person confirms or rejects the plan.
  await setState(db, task.id, 'waiting_review', { outputs: { ai_request_id: r.ai_request_id, proposal: plan, monitoring_mode: mode,
    ...decisionOf(inv) } });
  return { outcome: r.outcome, ai_request_id: r.ai_request_id, tasks_created: 0, suggestion_only: mode === 'suggestion_only', ...decisionOf(inv) };
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
