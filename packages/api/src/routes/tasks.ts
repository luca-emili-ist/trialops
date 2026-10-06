// Tasks, the new-arm wizard (M01-02) and the human review of agent proposals (AI-05, APP-TK-04).
import { route, uuid } from '../route.ts';
import type { Db, Row } from '../db.ts';
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { sign } from '../lib/sign.ts';
import { diffContent } from '../lib/diff.ts';
import { createArm, newArmSchema, type NewArm } from './arms.ts';
import { createDraft, getVersion, putSection, validateProtocolContent, PROTOCOL_KINDS, type ProtocolContent } from './protocol.ts';
import { runAgentTask, AGENTS } from '../agents/index.ts';

const OPEN = ['created', 'assigned', 'in_progress', 'waiting_review'];
const TASK_COLS = `t.id, t.platform_id, t.arm_id, a.code arm_code, t.site_id, t.type, t.title, t.subject_ref, t.assignee_kind, t.assignee,
  t.priority, t.gxp_impact, t.requires_signature, t.state, t.due_at, t.claimed_by, t.claimed_at, t.completed_at, t.review_signature_id,
  t.created_at, t.updated_at`;

async function getTask(db: Db, id: string): Promise<Row | undefined> {
  return (await db.query(`select ${TASK_COLS}, t.inputs, t.outputs from core.task t left join core.arm a on a.id = t.arm_id where t.id = $1`, [id])).rows[0];
}

interface SponsorDoc { ref: string; title: string; text: string }
interface WizardBody { arm: NewArm; sponsor_documents?: SponsorDoc[] }

async function startWizard(db: Db, claims: Claims, platformId: string, body: WizardBody): Promise<Row> {
  requireRole(claims, ['platform_admin', 'platform_ops_manager'], 'Starting the new-arm wizard');
  const arm = await createArm(db, claims, platformId, body.arm);
  const appendix = await createDraft(db, claims, PROTOCOL_KINDS.APPENDIX, arm.id, { version_label: '1.0', usdm: {} });
  const newTask = async (type: string, title: string, agent: string, gxp: boolean, inputs: Row) =>
    (await db.query(`insert into core.task(platform_id, arm_id, type, title, subject_ref, assignee_kind, assignee, gxp_impact,
        requires_signature, inputs, state, priority, due_at)
      values ($1,$2,$3,$4,$5,'agent',$6,$7,$7,$8,'assigned','high', clock_timestamp() + interval '1 day') returning id`,
      [platformId, arm.id, type, title, `arm/${arm.id}`, `agent:${agent}`, gxp, JSON.stringify(inputs)])).rows[0].id as string;
  const draftTask = await newTask('protocol.appendix.review', `Draft the ${arm.code} appendix for review`, AGENTS.protocolAuthor, true,
    { appendix_version_id: appendix.id, sponsor_documents: body.sponsor_documents ?? [] });
  const planTask = await newTask('arm.onboarding.plan', `Plan onboarding of ${arm.code}`, AGENTS.onboardingPlanner, false, {});
  return { arm, appendix_version: appendix, agent_tasks: [await getTask(db, draftTask), await getTask(db, planTask)] };
}

const REVIEW_DECISION = { accept: 'accepted', edit: 'edited', reject: 'rejected' } as const;

async function reviewProposal(db: Db, claims: Claims, reauth: Parameters<typeof sign>[2], taskId: string,
  body: { decision: keyof typeof REVIEW_DECISION; sections?: ProtocolContent; password?: string }): Promise<Row> {
  requirePerson(claims, 'Reviewing an agent proposal');
  requireRole(claims, PROTOCOL_KINDS.APPENDIX.editRoles, 'Reviewing an appendix proposal');
  const task = await getTask(db, taskId);
  if (!task) throw new HttpError(404, 'not_found', 'task not found');
  if (task.type !== 'protocol.appendix.review' || task.state !== 'waiting_review') {
    throw new HttpError(409, 'not_in_review', 'only an appendix proposal waiting for review can be reviewed');
  }
  const proposal = task.outputs?.proposal?.sections as ProtocolContent | undefined;
  if (!proposal) throw new HttpError(409, 'no_proposal', 'the task holds no proposal');
  const appendixId = task.inputs.appendix_version_id as string;
  let final: ProtocolContent | null = null;
  if (body.decision !== 'reject') {
    if (body.decision === 'edit' && !body.sections) throw new HttpError(400, 'sections_required', 'edit needs the edited sections');
    final = validateProtocolContent(body.decision === 'edit' ? body.sections : proposal, 'sections');
  }
  // 1. record the decision in the task, 2. sign it with re-authentication, 3. close the task with the signature.
  await db.query(`update core.task set outputs = outputs || $2::jsonb where id = $1`, [taskId, JSON.stringify({
    decision: REVIEW_DECISION[body.decision], decided_by: claims.sub,
    edits: body.decision === 'edit' ? diffContent(proposal, final ?? {}) : [] })]);
  const signature = await sign(db, claims, reauth, { target_table: 'task', target_id: taskId, meaning: 'review', credential: { password: body.password } });
  if (final) {
    for (const [section, content] of Object.entries(final)) await putSection(db, claims, PROTOCOL_KINDS.APPENDIX, appendixId, section, content);
    await db.query("update core.arm_appendix_version set status = 'in_review' where id = $1 and status = 'draft'", [appendixId]);
  }
  await db.query('update core.task set review_signature_id = $2, state = $3 where id = $1',
    [taskId, signature.id, final ? 'completed' : 'rejected']);
  if (task.outputs.ai_request_id) {
    await db.query('update core.ai_request set review_decision = $2, reviewer_sub = $3 where id = $1',
      [task.outputs.ai_request_id, REVIEW_DECISION[body.decision], claims.sub]);
  }
  return { task: await getTask(db, taskId), signature, appendix_version: await getVersion(db, PROTOCOL_KINDS.APPENDIX, appendixId) };
}

export const taskRoutes = [
  route<WizardBody>({ method: 'post', path: '/v1/platforms/:id/arm-wizard', status: 201, tag: 'wizard', reqs: ['M01-02', 'M01-04'],
    summary: 'New-arm wizard: draft arm, draft appendix and the tasks for the Protocol author and Onboarding planner agents',
    body: { type: 'object', additionalProperties: false, required: ['arm'], properties: {
      arm: newArmSchema,
      sponsor_documents: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['ref', 'title', 'text'],
        properties: { ref: { type: 'string', minLength: 1, maxLength: 60 }, title: { type: 'string' }, text: { type: 'string', maxLength: 50000 } } } } } },
    handler: async ({ db, claims, params, body }) => startWizard(db, claims, params.id!, body) }),

  route({ method: 'post', path: '/v1/tasks/:id/run-agent', summary: 'Run the agent a task is assigned to', tag: 'tasks',
    reqs: ['M01-02', 'AI-01', 'IAM-07'],
    handler: async ({ db, claims, params, services }) => {
      requireRole(claims, ['platform_admin', 'platform_ops_manager'], 'Running an agent');
      return runAgentTask(db, services, params.id!);
    } }),

  route({ method: 'get', path: '/v1/platforms/:id/tasks', summary: 'Task inbox (open by default; mine = my person or my roles)', tag: 'tasks',
    reqs: ['APP-TK-02'], query: { state: { enum: ['open', 'all'] }, arm_id: uuid, mine: { enum: ['true', 'false'] } },
    handler: async ({ db, claims, params, query }) => ({
      items: (await db.query(`select ${TASK_COLS} from core.task t left join core.arm a on a.id = t.arm_id
        where t.platform_id = $1 and ($2::boolean or t.state = any($3)) and ($4::uuid is null or t.arm_id = $4)
          and (not $5::boolean or (t.assignee_kind = 'role' and t.assignee = any($6)) or (t.assignee_kind = 'person' and t.assignee = $7))
        order by (t.state = 'waiting_review') desc, t.due_at nulls last, t.created_at`,
        [params.id, query.state === 'all', OPEN, query.arm_id ?? null, query.mine === 'true', claims.roles ?? [], claims.person_id ?? ''])).rows,
    }) }),

  route({ method: 'get', path: '/v1/tasks/:id', summary: 'Task with inputs, outputs and state history', tag: 'tasks', reqs: ['APP-TK-02'],
    handler: async ({ db, params }) => {
      const t = await getTask(db, params.id!);
      if (!t) return undefined;
      const events = (await db.query('select from_state, to_state, actor_sub, actor_type, at from core.task_event where task_id = $1 order by id',
        [t.id])).rows;
      return { ...t, events };
    } }),

  route({ method: 'get', path: '/v1/tasks/:id/proposal-diff', summary: 'Diff between the appendix draft and the agent proposal', tag: 'tasks',
    reqs: ['M01-02', 'AI-05'],
    handler: async ({ db, params }) => {
      const t = await getTask(db, params.id!);
      if (!t) return undefined;
      const proposal = t.outputs?.proposal;
      if (!proposal) throw new HttpError(409, 'no_proposal', 'the task holds no proposal yet');
      const draft = await getVersion(db, PROTOCOL_KINDS.APPENDIX, t.inputs.appendix_version_id);
      return { task_id: t.id, appendix_version_id: draft?.id ?? null, sections: diffContent(draft?.usdm ?? {}, proposal.sections),
        sources: proposal.sources ?? [], consistency_checks: proposal.consistency_checks ?? [] };
    } }),

  route<{ decision: keyof typeof REVIEW_DECISION; sections?: ProtocolContent; password?: string }>({
    method: 'post', path: '/v1/tasks/:id/review', needsReason: true, tag: 'tasks', reqs: ['AI-05', 'APP-TK-04', 'M01-02', 'CMP-02'],
    summary: 'Accept, edit or reject an agent proposal with a signature',
    body: { type: 'object', additionalProperties: false, required: ['decision'],
      properties: { decision: { enum: ['accept', 'edit', 'reject'] }, sections: { type: 'object' }, password: { type: 'string' } } },
    handler: async ({ db, claims, params, body, services }) => reviewProposal(db, claims, services.reauth, params.id!, body) }),

  route({ method: 'get', path: '/v1/platforms/:id/ai-review-stats', summary: 'Acceptance and edit rate of AI proposals per task type',
    tag: 'ai', reqs: ['AI-05'],
    handler: async ({ db, params }) => ({
      items: (await db.query(`select task_type, count(*)::int calls,
          count(*) filter (where review_decision is not null)::int reviewed,
          count(*) filter (where review_decision = 'accepted')::int accepted,
          count(*) filter (where review_decision = 'edited')::int edited,
          count(*) filter (where review_decision = 'rejected')::int rejected
        from core.ai_request where platform_id = $1 group by task_type order by task_type`, [params.id])).rows,
    }) }),
];
