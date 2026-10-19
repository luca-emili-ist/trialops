// Internal policy engine for agent tool calls (AI-08; Deontos out of scope, decision 4 of 2026-10-06). Deterministic
// rules over the tool registry (AI-07), the agent, its perimeter and the AI-10 state of the task type: every call ends in
// ALLOW (the tool runs), REVIEW (a pending action waits for a person with a confirm role) or BLOCK (refused), and every
// decision, including the confirmation or rejection by a person, is written as a signed, hash-chained Agent Decision
// Record (lib/decision-signing.ts, migration 0025). Unregistered tools are BLOCK; a GxP write is never run without a person.
import { randomUUID } from 'node:crypto';
import type { Db, Row } from '../db.ts';
import type { Claims } from '../auth.ts';
import type { Services } from '../route.ts';
import { HttpError } from '../errors.ts';
import { contentHash } from './canonical.ts';
import { appendDecision, decisionSignerFromEnv, type DecisionSigner } from './decision-signing.ts';
import { taskTypeMode, type Mode } from './ai-monitoring.ts';
import { requirePerson } from './roles.ts';
import { TOOL_EXECUTORS } from '../agents/tools.ts';

export const POLICY_VERSION = 'trialops-policy/1';
export type Decision = 'ALLOW' | 'REVIEW' | 'BLOCK';

/** The rules, in the order they are evaluated; the first decisive one decides. */
export const RULES = {
  'AI07-UNREGISTERED': 'the tool is not in the registry: unregistered tools are BLOCK',
  'AI08-PERIMETER': 'the platform is outside the perimeter of the actor',
  'AI07-MODE-BLOCK': 'the tool is registered as BLOCK',
  'AI07-AGENT-NOT-ALLOWED': 'the agent is not among the agents allowed to use the tool',
  'AI08-NO-EXECUTOR': 'the tool has no executor in this release: refused',
  'AI07-HUMAN-REJECTED': 'a person with a confirm role rejected the pending action',
  'AI07-HUMAN-CONFIRMED': 'a person with a confirm role confirmed the pending action',
  'AI07-GXP-NEVER-AUTO': 'a GxP write is never run without a person (registry inconsistent: treated as CONFIRM)',
  'AI10-SUGGESTION-ONLY': 'the task type is suggestion-only (AI-10): writes wait for a person',
  'AI07-MODE-CONFIRM': 'the tool is registered as CONFIRM: a person confirms before it runs',
  'AI07-MODE-AUTO': 'the tool is registered as AUTO: it runs without a person',
} as const;
export type RuleId = keyof typeof RULES;

export interface ToolEntry {
  id: string; platform_id: string | null; tool: string; effect: 'read' | 'proposal' | 'operational_write' | 'gxp_write';
  risk_level: string; agents: string[]; confirm_roles: string[]; mode: 'AUTO' | 'CONFIRM' | 'BLOCK'; version: number; version_id: string;
}

export interface PolicyInput {
  agentId: string;
  entry: ToolEntry | null;
  inPerimeter: boolean;
  hasExecutor: boolean;
  taskTypeMode?: Mode | null;
  /** A person deciding on a pending action (role already checked). */
  human?: 'confirm' | 'reject';
}

export function evaluate(i: PolicyInput): { decision: Decision; rule_ids: RuleId[]; rationale: string } {
  const out = (decision: Decision, rule: RuleId) => ({ decision, rule_ids: [rule], rationale: `${POLICY_VERSION}: ${RULES[rule]}` });
  const e = i.entry;
  if (!e) return out('BLOCK', 'AI07-UNREGISTERED');
  if (!i.inPerimeter) return out('BLOCK', 'AI08-PERIMETER');
  if (e.mode === 'BLOCK') return out('BLOCK', 'AI07-MODE-BLOCK');
  if (!e.agents.includes(i.agentId)) return out('BLOCK', 'AI07-AGENT-NOT-ALLOWED');
  if (!i.hasExecutor) return out('BLOCK', 'AI08-NO-EXECUTOR');
  if (i.human === 'reject') return out('BLOCK', 'AI07-HUMAN-REJECTED');
  if (i.human === 'confirm') return out('ALLOW', 'AI07-HUMAN-CONFIRMED');
  if (e.effect === 'gxp_write' && e.mode === 'AUTO') return out('REVIEW', 'AI07-GXP-NEVER-AUTO');
  if (i.taskTypeMode === 'suggestion_only' && (e.effect === 'operational_write' || e.effect === 'gxp_write')) return out('REVIEW', 'AI10-SUGGESTION-ONLY');
  if (e.mode === 'CONFIRM') return out('REVIEW', 'AI07-MODE-CONFIRM');
  return out('ALLOW', 'AI07-MODE-AUTO');
}

export const signerOf = (services: Services): DecisionSigner => services.decisions ?? decisionSignerFromEnv();

export async function resolveTool(db: Db, platformId: string, tool: string): Promise<ToolEntry | null> {
  return ((await db.query('select * from core.ai_tool_resolve($1, $2)', [platformId, tool])).rows[0] as ToolEntry | undefined) ?? null;
}

export interface ToolCall {
  agentId: string;
  tool: string;
  args: Row;
  platformId: string;
  armId?: string | null;
  taskId?: string | null;
  /** The AI call whose output the tool acts on (model and prompt version go in the record). */
  ai?: { ai_request_id: string; task_type: string };
}

export interface ToolOutcome {
  decision: Decision; rule_ids: RuleId[]; decision_record_id: string; pending_action_id: string | null; result: Row | null;
}

async function actor(db: Db, platformId: string): Promise<{ sub: string; type: string; inPerimeter: boolean }> {
  const r = (await db.query('select core.current_sub() sub, core.current_actor_type() type, core.can_see_platform($1) p', [platformId])).rows[0]!;
  return { sub: r.sub, type: r.type, inPerimeter: r.p === true };
}

/** The only way an agent acts on platform data: decide, record (signed), then run, queue for a person, or refuse. */
export async function invokeTool(db: Db, services: Services, call: ToolCall): Promise<ToolOutcome> {
  const me = await actor(db, call.platformId);
  if (me.type !== 'agent') throw new HttpError(403, 'agent_required', 'tools are invoked by agents under their own identity (IAM-07)');
  const entry = await resolveTool(db, call.platformId, call.tool);
  const mode = call.ai ? await taskTypeMode(db, call.platformId, call.ai.task_type) : null;
  const verdict = evaluate({ agentId: call.agentId, entry, inPerimeter: me.inPerimeter, hasExecutor: !!TOOL_EXECUTORS[call.tool], taskTypeMode: mode });
  const def = call.ai ? services.ai?.registry[call.ai.task_type] : undefined;
  const id = randomUUID();
  const pendingId = verdict.decision === 'REVIEW' ? randomUUID() : null;
  await appendDecision(db, signerOf(services), {
    id, agent_id: call.agentId, tool: call.tool, tool_version_id: entry?.version_id ?? null, tool_mode: entry?.mode ?? null,
    platform_id: call.platformId, arm_id: call.armId ?? null, task_id: call.taskId ?? null, pending_action_id: pendingId,
    decision: verdict.decision, rule_ids: verdict.rule_ids, rationale: verdict.rationale, inputs_sha256: contentHash(call.args),
    ai_request_id: call.ai?.ai_request_id ?? null, model: def?.model ?? null, prompt_id: def?.prompt_id ?? null,
    prompt_version: def?.prompt_version != null ? String(def.prompt_version) : null, actor_sub: me.sub, actor_type: me.type,
  }, { args: call.args, ai_task_type: call.ai?.task_type ?? null, task_type_mode: mode });
  let result: Row | null = null;
  if (verdict.decision === 'REVIEW') {
    await db.query('select core.ai_pending_action_create($1, $2, $3)', [pendingId, id, JSON.stringify(call.args)]);
  } else if (verdict.decision === 'ALLOW') {
    result = await TOOL_EXECUTORS[call.tool]!.execute(db, call.args, {});
  }
  return { decision: verdict.decision, rule_ids: verdict.rule_ids, decision_record_id: id, pending_action_id: pendingId, result };
}

export const PENDING_COLS = `id, platform_id, arm_id, task_id, agent_id, tool, tool_version_id, args_sha256, confirm_roles, status,
  request_decision_id, requested_by, requested_at, decided_by, decided_at, decision_reason, final_decision_id, result, created_at, updated_at, row_version`;

/**
 * A person confirms or rejects a pending action. The engine evaluates the call again with the registry in force (a tool
 * set to BLOCK meanwhile is refused even if confirmed), records the decision (signed), then runs the tool as that person
 * or records the rejection. The database checks role, state and the link between decision record and pending action.
 */
export async function decidePendingAction(db: Db, services: Services, claims: Claims, id: string, decision: 'confirm' | 'reject',
  reason: string | undefined): Promise<Row> {
  requirePerson(claims, 'Confirming an agent action');
  if (!reason) throw new HttpError(400, 'reason_required', 'X-Change-Reason header required for this change (DM-03)');
  const p = (await db.query(`select ${PENDING_COLS}, args from core.ai_pending_action where id = $1`, [id])).rows[0];
  if (!p) throw new HttpError(404, 'not_found', 'pending action not found');
  if (p.status !== 'pending') throw new HttpError(409, 'not_pending', `pending action is already ${p.status}`);
  const roles = claims.roles ?? [];
  if (!(p.confirm_roles as string[]).some(r => roles.includes(r))) {
    throw new HttpError(403, 'role_required', `Confirming this agent action requires one of: ${(p.confirm_roles as string[]).join(', ')}`);
  }
  const me = await actor(db, p.platform_id);
  const entry = await resolveTool(db, p.platform_id, p.tool);
  const verdict = evaluate({ agentId: p.agent_id, entry, inPerimeter: me.inPerimeter, hasExecutor: !!TOOL_EXECUTORS[p.tool], human: decision });
  const decisionId = randomUUID();
  await appendDecision(db, signerOf(services), {
    id: decisionId, agent_id: p.agent_id, tool: p.tool, tool_version_id: entry?.version_id ?? null, tool_mode: entry?.mode ?? null,
    platform_id: p.platform_id, arm_id: p.arm_id ?? null, task_id: p.task_id ?? null, pending_action_id: p.id,
    decision: verdict.decision, rule_ids: verdict.rule_ids, rationale: `${verdict.rationale}; reason: ${reason}`,
    inputs_sha256: p.args_sha256, ai_request_id: p.args?.ai_request_id ?? null, model: null, prompt_id: null, prompt_version: null,
    actor_sub: me.sub, actor_type: me.type,
  }, { pending_action_id: p.id, human_decision: decision, reason });
  let status: 'executed' | 'rejected' | 'blocked';
  let result: Row | null = null;
  if (verdict.decision === 'ALLOW') {
    result = await TOOL_EXECUTORS[p.tool]!.execute(db, p.args, { confirmedBy: claims.sub, pendingActionId: p.id });
    status = 'executed';
  } else if (decision === 'reject') {
    await TOOL_EXECUTORS[p.tool]?.reject?.(db, p.args, { decidedBy: claims.sub, pendingActionId: p.id });
    status = 'rejected';
  } else {
    status = 'blocked';
  }
  const row = (await db.query(`select ${PENDING_COLS} from core.ai_pending_action_decide($1, $2, $3, $4, $5)`,
    [p.id, status, reason, decisionId, result ? JSON.stringify(result) : null])).rows[0];
  return { pending_action: row, decision: verdict.decision, rule_ids: verdict.rule_ids, decision_record_id: decisionId, result };
}
