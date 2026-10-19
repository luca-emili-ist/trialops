// AI governance (AI-07, AI-08): the tool registry (AUTO / CONFIRM / BLOCK, versioned, changed by a platform admin with a
// reason), the pending actions a person confirms or rejects, and the signed Agent Decision Records with their verification.
import { route, uuid, type Ctx } from '../route.ts';
import { HttpError } from '../errors.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { decidePendingAction, PENDING_COLS, resolveTool, signerOf, RULES, POLICY_VERSION } from '../lib/policy-engine.ts';
import { verifyDecisions } from '../lib/decision-signing.ts';
import { TOOL_EXECUTORS } from '../agents/tools.ts';

const toolReaders = ['platform_admin', 'platform_ops_manager', 'qa_auditor', 'regulatory_lead'] as const;
const decisionReaders = ['qa_auditor', 'platform_admin'] as const;

function platformOf(ctx: Ctx<unknown>, asked: string | undefined): string {
  if (asked) return asked;
  const mine = ctx.claims.platform_ids ?? [];
  if (mine.length === 1) return mine[0]!;
  throw new HttpError(400, 'platform_required', 'platform_id is required (the token covers several platforms)');
}

const DECISION_COLS = `id, seq, decided_at, agent_id, tool, tool_version_id, tool_mode, platform_id, arm_id, task_id, pending_action_id,
  decision, policies_applied rule_ids, rationale, inputs_sha256, ai_request_id, model, prompt_id, prompt_version, actor_sub, actor_type,
  record_sha256, prev_record_sha256, signature_status, key_id`;

export const aiGovernanceRoutes = [
  route({ method: 'get', path: '/v1/ai/tools', tag: 'ai', reqs: ['AI-07'], query: { platform_id: uuid },
    summary: 'Tool registry in force on a platform: mode AUTO/CONFIRM/BLOCK, effect, agents, confirm roles, version (unregistered = BLOCK)',
    handler: async ctx => {
      requireRole(ctx.claims, [...toolReaders], 'Reading the AI tool registry');
      const platform = platformOf(ctx, ctx.query.platform_id);
      const names = (await ctx.db.query('select distinct tool from core.ai_tool order by tool')).rows.map(r => r.tool as string);
      const items = [];
      for (const n of names) {
        const e = await resolveTool(ctx.db, platform, n);
        if (e) items.push({ ...e, scope: e.platform_id ? 'platform' : 'default', executor: !!TOOL_EXECUTORS[n] });
      }
      return { platform_id: platform, default_for_unregistered: 'BLOCK', policy: POLICY_VERSION, rules: RULES, items };
    } }),

  route({ method: 'get', path: '/v1/ai/tools/:tool/versions', tag: 'ai', reqs: ['AI-07'], query: { platform_id: uuid },
    summary: 'Version history of a tool (default and platform override): mode, reason, who and when',
    handler: async ctx => {
      requireRole(ctx.claims, [...toolReaders], 'Reading the AI tool registry');
      const platform = platformOf(ctx, ctx.query.platform_id);
      const items = (await ctx.db.query(`select id, ai_tool_id, platform_id, tool, version, effect, risk_level, agents, confirm_roles, mode,
          reason, changed_by, changed_at, case when platform_id is null then 'default' else 'platform' end scope
        from core.ai_tool_version where tool = $1 and (platform_id is null or platform_id = $2) order by changed_at, version`,
        [ctx.params.tool, platform])).rows;
      if (!items.length) throw new HttpError(404, 'not_found', `tool ${ctx.params.tool} is not registered (AI-07: BLOCK)`);
      return { platform_id: platform, tool: ctx.params.tool, items };
    } }),

  route<{ platform_id?: string; mode: 'AUTO' | 'CONFIRM' | 'BLOCK' }>({ method: 'post', path: '/v1/ai/tools/:tool/mode', needsReason: true,
    tag: 'ai', reqs: ['AI-07'], summary: 'Set the mode of a tool on a platform (platform admin, with a reason; versioned and audited; a GxP write is never AUTO)',
    body: { type: 'object', additionalProperties: false, required: ['mode'], properties: { platform_id: uuid, mode: { enum: ['AUTO', 'CONFIRM', 'BLOCK'] } } },
    handler: async ctx => {
      requirePerson(ctx.claims, 'Changing the mode of an AI tool');
      requireRole(ctx.claims, ['platform_admin'], 'Changing the mode of an AI tool');
      const platform = platformOf(ctx, ctx.body.platform_id);
      await ctx.db.query('select core.ai_tool_set_mode($1, $2, $3, $4)', [platform, ctx.params.tool, ctx.body.mode, ctx.reason]);
      return resolveTool(ctx.db, platform, ctx.params.tool!);
    } }),

  route({ method: 'get', path: '/v1/ai/pending-actions', tag: 'ai', reqs: ['AI-07'],
    query: { platform_id: uuid, status: { enum: ['pending', 'executed', 'rejected', 'blocked', 'all'] }, task_id: uuid },
    summary: 'Agent actions waiting for a person (CONFIRM), or decided ones; mine: those my roles can confirm',
    handler: async ctx => {
      const platform = platformOf(ctx, ctx.query.platform_id);
      const status = ctx.query.status ?? 'pending';
      const items = (await ctx.db.query(`select ${PENDING_COLS}, args, (confirm_roles && $4::text[]) can_confirm from core.ai_pending_action
        where platform_id = $1 and ($2 = 'all' or status = $2) and ($3::uuid is null or task_id = $3) order by requested_at desc limit 200`,
        [platform, status, ctx.query.task_id ?? null, ctx.claims.roles ?? []])).rows;
      return { platform_id: platform, items };
    } }),

  route({ method: 'get', path: '/v1/ai/pending-actions/:id', tag: 'ai', reqs: ['AI-07'], summary: 'A pending agent action with its arguments and decisions',
    handler: async ({ db, params }) => {
      const p = (await db.query(`select ${PENDING_COLS}, args from core.ai_pending_action where id = $1`, [params.id])).rows[0];
      if (!p) return undefined;
      const decisions = (await db.query(`select ${DECISION_COLS} from core.agent_decision_record where pending_action_id = $1 order by seq`, [p.id])).rows;
      return { ...p, decisions };
    } }),

  route<{ decision: 'confirm' | 'reject' }>({ method: 'post', path: '/v1/ai/pending-actions/:id/decide', needsReason: true, tag: 'ai',
    reqs: ['AI-07', 'AI-08', 'AI-05'],
    summary: 'Confirm (the tool runs as the person) or reject an agent action; the policy engine re-evaluates and records a signed decision',
    body: { type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { enum: ['confirm', 'reject'] } } },
    handler: async ctx => decidePendingAction(ctx.db, ctx.services, ctx.claims, ctx.params.id!, ctx.body.decision, ctx.reason) }),

  route({ method: 'get', path: '/v1/ai/decisions', tag: 'ai', reqs: ['AI-08'],
    query: { platform_id: uuid, task_id: uuid, decision: { enum: ['ALLOW', 'REVIEW', 'BLOCK'] }, tool: { type: 'string', maxLength: 100 } },
    summary: 'Agent Decision Records of a platform (QA auditors, platform admins): decision, rules, inputs hash, model/prompt, signature',
    handler: async ctx => {
      requirePerson(ctx.claims, 'Reading the Agent Decision Records');
      requireRole(ctx.claims, [...decisionReaders], 'Reading the Agent Decision Records');
      const platform = platformOf(ctx, ctx.query.platform_id);
      const items = (await ctx.db.query(`select ${DECISION_COLS} from core.agent_decision_record where platform_id = $1
          and ($2::uuid is null or task_id = $2) and ($3::text is null or decision = $3) and ($4::text is null or tool = $4)
        order by seq desc nulls last limit 500`, [platform, ctx.query.task_id ?? null, ctx.query.decision ?? null, ctx.query.tool ?? null])).rows;
      return { platform_id: platform, items };
    } }),

  route({ method: 'get', path: '/v1/ai/decisions/verify', tag: 'ai', reqs: ['AI-08'],
    summary: 'Verify the whole Agent Decision Record chain: sequence, hash links, payload hashes and Ed25519 signatures; unsigned records are anomalies',
    handler: async ctx => {
      requirePerson(ctx.claims, 'Verifying the Agent Decision Records');
      requireRole(ctx.claims, [...decisionReaders], 'Verifying the Agent Decision Records');
      const s = signerOf(ctx.services);
      return { ...(await verifyDecisions(ctx.db)), signer: { mode: s.mode, key_id: s.keyId } };
    } }),
];
