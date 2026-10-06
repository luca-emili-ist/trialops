// Arms and their lifecycle (M01-04): draft -> approved -> active -> suspended -> closed / graduated, plus stages.
// The database enforces the allowed transitions and emits the events; the API adds role checks and the rule that an
// arm is approved only with an approved appendix.
import { route, uuid } from '../route.ts';
import type { Db, Row } from '../db.ts';
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { requireRole } from '../lib/roles.ts';

const ARM_COLS = `a.id, a.platform_id, a.code, a.name, a.sponsor_org_id, o.name sponsor, a.intervention_type, a.has_prior_human_data,
  a.approved_any_indication, a.status, a.current_stage, a.created_at, a.updated_at, a.row_version`;
const STATUSES = ['approved', 'active', 'suspended', 'closed', 'graduated', 'void'];
const STAGES = ['dose_finding', 'expansion', 'efficacy', 'confirmatory'];

export interface NewArm {
  code: string; name: string; sponsor_org_id?: string; intervention_type: 'drug' | 'biologic' | 'control';
  has_prior_human_data?: boolean; approved_any_indication?: boolean;
}
export const newArmSchema = {
  type: 'object', additionalProperties: false, required: ['code', 'name', 'intervention_type'],
  properties: {
    code: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{1,19}$' }, name: { type: 'string', minLength: 1, maxLength: 200 },
    sponsor_org_id: uuid, intervention_type: { enum: ['drug', 'biologic', 'control'] },
    has_prior_human_data: { type: 'boolean' }, approved_any_indication: { type: 'boolean' },
  },
};

export async function getArm(db: Db, id: string): Promise<Row | undefined> {
  return (await db.query(`select ${ARM_COLS} from core.arm a left join core.organization o on o.id = a.sponsor_org_id where a.id = $1`, [id])).rows[0];
}

export async function createArm(db: Db, claims: Claims, platformId: string, b: NewArm): Promise<Row> {
  requireRole(claims, ['platform_admin', 'platform_ops_manager'], 'Creating an arm');
  const id = (await db.query(`insert into core.arm(platform_id, code, name, sponsor_org_id, intervention_type, has_prior_human_data, approved_any_indication)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`, [platformId, b.code, b.name, b.sponsor_org_id ?? null, b.intervention_type,
    b.has_prior_human_data ?? null, b.approved_any_indication ?? null])).rows[0].id;
  return (await getArm(db, id))!;
}

export const armRoutes = [
  route({ method: 'get', path: '/v1/platforms/:id/arms', summary: 'Arms of a platform visible to the caller', tag: 'arms', reqs: ['M01-04', 'IAM-03'],
    handler: async ({ db, params }) => ({
      items: (await db.query(`select ${ARM_COLS} from core.arm a left join core.organization o on o.id = a.sponsor_org_id
        where a.platform_id = $1 and a.status <> 'void' order by a.code`, [params.id])).rows,
    }) }),

  route<NewArm>({ method: 'post', path: '/v1/platforms/:id/arms', status: 201, summary: 'Create a draft arm', tag: 'arms', reqs: ['M01-04'],
    body: newArmSchema, handler: async ({ db, claims, params, body }) => createArm(db, claims, params.id!, body) }),

  route({ method: 'get', path: '/v1/arms/:id', summary: 'Arm detail with appendix versions, stage history and site activations', tag: 'arms',
    reqs: ['M01-04', 'M02-03'],
    handler: async ({ db, params }) => {
      const arm = await getArm(db, params.id!);
      if (!arm) return undefined;
      const [appendices, stages, activations] = await Promise.all([
        db.query(`select id, version_label, status, approved_signature_id, created_at from core.arm_appendix_version
          where arm_id = $1 and status <> 'void' order by created_at`, [arm.id]),
        db.query(`select from_stage, to_stage, transitioned_at from core.arm_stage_transition where arm_id = $1 and status <> 'void'
          order by transitioned_at`, [arm.id]),
        db.query(`select x.id, x.site_id, s.site_number, x.status, x.green_light_at from core.site_arm_activation x
          join core.site s on s.id = x.site_id where x.arm_id = $1 and x.status <> 'void' order by s.site_number`, [arm.id]),
      ]);
      return { ...arm, appendix_versions: appendices.rows, stage_history: stages.rows, site_activations: activations.rows };
    } }),

  route<{ to: string }>({ method: 'post', path: '/v1/arms/:id/status', needsReason: true, summary: 'Move an arm along its lifecycle',
    tag: 'arms', reqs: ['M01-04', 'DM-03'],
    body: { type: 'object', required: ['to'], additionalProperties: false, properties: { to: { enum: STATUSES } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, ['platform_admin', 'platform_ops_manager'], 'Changing the arm status');
      const arm = await getArm(db, params.id!);
      if (!arm) return undefined;
      if (body.to === 'approved') {
        const ok = (await db.query("select 1 from core.arm_appendix_version where arm_id = $1 and status = 'approved'", [arm.id])).rowCount;
        if (!ok) throw new HttpError(422, 'appendix_not_approved', 'an arm is approved only with an approved appendix (M01-04)');
      }
      await db.query('update core.arm set status = $2 where id = $1', [arm.id, body.to]);
      return getArm(db, arm.id);
    } }),

  route<{ to_stage: string; decision_record_id?: string }>({ method: 'post', path: '/v1/arms/:id/stage', needsReason: true,
    summary: 'Record a stage transition of an active arm', tag: 'arms', reqs: ['M01-04', 'DM-03'],
    body: { type: 'object', required: ['to_stage'], additionalProperties: false,
      properties: { to_stage: { enum: STAGES }, decision_record_id: uuid } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, ['platform_admin', 'platform_ops_manager'], 'Changing the arm stage');
      const arm = await getArm(db, params.id!);
      if (!arm) return undefined;
      if (arm.status !== 'active') throw new HttpError(409, 'arm_not_active', 'stages change only on active arms');
      await db.query(`insert into core.arm_stage_transition(platform_id, arm_id, from_stage, to_stage, decision_record_id)
        values ($1,$2,$3,$4,$5)`, [arm.platform_id, arm.id, arm.current_stage, body.to_stage, body.decision_record_id ?? null]);
      await db.query('update core.arm set current_stage = $2 where id = $1', [arm.id, body.to_stage]);
      return getArm(db, arm.id);
    } }),
];
