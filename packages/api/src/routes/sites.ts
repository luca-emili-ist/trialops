// Site network (M02-01 registry, M02-03 per-arm activation workflow). Perimeter by RLS (platform + site scopes).
import { route, uuid } from '../route.ts';
import type { Db, Row } from '../db.ts';
import { HttpError } from '../errors.ts';
import { requireRole, type Role } from '../lib/roles.ts';

const SITE_EDITORS: Role[] = ['platform_admin', 'platform_ops_manager', 'ctm'];
export const ACTIVATION_STEPS = ['qualified', 'contract_executed', 'irb_approved', 'training_done', 'green_light'] as const;
type Step = typeof ACTIVATION_STEPS[number];

const SITE_COLS = `s.id, s.platform_id, s.site_number, o.name, s.org_id, s.country, s.declared_capacity_per_month, s.status, s.created_at, s.row_version`;

async function getSite(db: Db, id: string): Promise<Row | undefined> {
  return (await db.query(`select ${SITE_COLS} from core.site s join core.organization o on o.id = s.org_id where s.id = $1`, [id])).rows[0];
}

async function getActivation(db: Db, id: string): Promise<Row | undefined> {
  return (await db.query(`select x.*, s.site_number, a.code arm_code from core.site_arm_activation x
    join core.site s on s.id = x.site_id join core.arm a on a.id = x.arm_id where x.id = $1`, [id])).rows[0];
}

export function nextStep(act: Row): Step | null {
  return ACTIVATION_STEPS.find(s => act[`${s}_at`] == null) ?? null;
}

const registryChild = (path: string, table: string, summary: string, props: Record<string, object>, required: string[]) =>
  route<Record<string, unknown>>({ method: 'post', path: `/v1/sites/:id/${path}`, status: 201, summary, tag: 'sites', reqs: ['M02-01'],
    body: { type: 'object', additionalProperties: false, required, properties: props },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, SITE_EDITORS, 'Editing the site registry');
      const site = await getSite(db, params.id!);
      if (!site) return undefined;
      const cols = Object.keys(body);
      return (await db.query(`insert into core.${table}(platform_id, site_id, ${cols.join(',')})
        values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(',')}) returning *`, [site.platform_id, site.id, ...cols.map(c => body[c])])).rows[0];
    } });

export const siteRoutes = [
  route({ method: 'get', path: '/v1/organizations', summary: 'Organizations (optionally by type)', tag: 'sites', reqs: ['M02-01'],
    query: { type: { type: 'string' } },
    handler: async ({ db, query }) => ({
      items: (await db.query(`select id, name, org_type, is_small_business, country from core.organization
        where status = 'active' and ($1::text is null or org_type = $1) order by name`, [query.type ?? null])).rows,
    }) }),

  route({ method: 'get', path: '/v1/platforms/:id/sites', summary: 'Site registry of a platform with enrollment and activations',
    tag: 'sites', reqs: ['M02-01', 'IAM-02'],
    handler: async ({ db, params }) => ({
      items: (await db.query(`select ${SITE_COLS},
          (select full_name from core.site_investigator i where i.site_id = s.id and i.investigator_role = 'principal' and i.status = 'active' limit 1) pi_name,
          (select count(*)::int from core.site_certification c where c.site_id = s.id and c.status = 'active') certifications,
          (select count(*)::int from core.site_concurrent_trial t where t.site_id = s.id and t.status = 'ongoing' and t.competes_for_population) competing_trials,
          coalesce(f.identified, 0)::int identified, coalesce(f.randomized, 0)::int randomized,
          (select count(*)::int from core.site_arm_activation x where x.site_id = s.id and x.status = 'activated') arms_activated
        from core.site s join core.organization o on o.id = s.org_id
        left join core.v_enrollment_funnel f on f.site_id = s.id
        where s.platform_id = $1 and s.status <> 'void' order by s.site_number`, [params.id])).rows,
    }) }),

  route<{ org_id: string; site_number: string; country: string; declared_capacity_per_month?: number }>({
    method: 'post', path: '/v1/platforms/:id/sites', status: 201, summary: 'Register a candidate site', tag: 'sites', reqs: ['M02-01'],
    body: { type: 'object', additionalProperties: false, required: ['org_id', 'site_number', 'country'],
      properties: { org_id: uuid, site_number: { type: 'string', minLength: 1, maxLength: 20 }, country: { type: 'string', minLength: 2, maxLength: 2 },
        declared_capacity_per_month: { type: 'number', minimum: 0 } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, SITE_EDITORS, 'Registering a site');
      const org = (await db.query("select org_type from core.organization where id = $1", [body.org_id])).rows[0];
      if (org?.org_type !== 'site') throw new HttpError(422, 'not_a_site_org', 'org_id must be an organization of type site');
      const id = (await db.query(`insert into core.site(platform_id, org_id, site_number, country, declared_capacity_per_month)
        values ($1,$2,$3,$4,$5) returning id`, [params.id, body.org_id, body.site_number, body.country, body.declared_capacity_per_month ?? null])).rows[0].id;
      return getSite(db, id);
    } }),

  route({ method: 'get', path: '/v1/sites/:id', summary: 'Site detail: investigators, certifications, concurrent trials, arm activations',
    tag: 'sites', reqs: ['M02-01', 'M02-03'],
    handler: async ({ db, params }) => {
      const site = await getSite(db, params.id!);
      if (!site) return undefined;
      const [inv, cert, trials, acts] = await Promise.all([
        db.query(`select id, full_name, investigator_role, specialty, gcp_training_valid_until, status from core.site_investigator
          where site_id = $1 and status <> 'void' order by investigator_role, full_name`, [site.id]),
        db.query(`select id, kind, issuer, valid_until, status from core.site_certification where site_id = $1 and status <> 'void' order by kind`, [site.id]),
        db.query(`select id, title, registry_id, competes_for_population, status from core.site_concurrent_trial
          where site_id = $1 and status <> 'void' order by title`, [site.id]),
        db.query(`select x.id, x.arm_id, a.code arm_code, x.status, x.qualified_at, x.contract_executed_at, x.irb_approved_at,
            x.training_done_at, x.green_light_at from core.site_arm_activation x join core.arm a on a.id = x.arm_id
          where x.site_id = $1 and x.status <> 'void' order by a.code`, [site.id]),
      ]);
      return { ...site, investigators: inv.rows, certifications: cert.rows, concurrent_trials: trials.rows,
        activations: acts.rows.map(a => ({ ...a, next_step: nextStep(a) })) };
    } }),

  registryChild('investigators', 'site_investigator', 'Add an investigator to a site', {
    full_name: { type: 'string', minLength: 1 }, investigator_role: { enum: ['principal', 'sub'] }, specialty: { type: 'string' },
    gcp_training_valid_until: { type: 'string', format: 'date' }, person_id: uuid }, ['full_name', 'investigator_role']),
  registryChild('certifications', 'site_certification', 'Add a certification to a site', {
    kind: { type: 'string', minLength: 1 }, issuer: { type: 'string' }, valid_until: { type: 'string', format: 'date' } }, ['kind']),
  registryChild('concurrent-trials', 'site_concurrent_trial', 'Declare a concurrent trial at a site', {
    title: { type: 'string', minLength: 1 }, registry_id: { type: 'string' }, competes_for_population: { type: 'boolean' } }, ['title']),

  route({ method: 'get', path: '/v1/arms/:id/site-activations', summary: 'Activation workflow of every site for an arm', tag: 'sites',
    reqs: ['M02-03'],
    handler: async ({ db, params }) => ({
      items: (await db.query(`select x.*, s.site_number, o.name site_name from core.site_arm_activation x
          join core.site s on s.id = x.site_id join core.organization o on o.id = s.org_id
        where x.arm_id = $1 and x.status <> 'void' order by s.site_number`, [params.id])).rows.map(a => ({ ...a, next_step: nextStep(a) })),
    }) }),

  route<{ site_id: string }>({ method: 'post', path: '/v1/arms/:id/site-activations', status: 201, summary: 'Start activating a site for an arm',
    tag: 'sites', reqs: ['M02-03'],
    body: { type: 'object', additionalProperties: false, required: ['site_id'], properties: { site_id: uuid } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, SITE_EDITORS, 'Starting a site activation');
      const arm = (await db.query('select id, platform_id, status from core.arm where id = $1', [params.id])).rows[0];
      if (!arm) return undefined;
      if (['closed', 'graduated', 'void'].includes(arm.status)) throw new HttpError(409, 'arm_closed', `arm is ${arm.status}`);
      const id = (await db.query(`insert into core.site_arm_activation(platform_id, arm_id, site_id) values ($1,$2,$3) returning id`,
        [arm.platform_id, arm.id, body.site_id])).rows[0].id;
      return getActivation(db, id);
    } }),

  route<{ at?: string }>({ method: 'post', path: '/v1/site-activations/:id/steps/:step', needsReason: true,
    summary: 'Date the next activation step (qualified, contract_executed, irb_approved, training_done, green_light)',
    tag: 'sites', reqs: ['M02-03', 'DM-03'],
    body: { type: 'object', additionalProperties: false, properties: { at: { type: 'string', format: 'date-time' } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, SITE_EDITORS, 'Recording an activation step');
      const step = params.step as Step;
      if (!ACTIVATION_STEPS.includes(step)) throw new HttpError(404, 'unknown_step', `steps: ${ACTIVATION_STEPS.join(', ')}`);
      const act = await getActivation(db, params.id!);
      if (!act) return undefined;
      if (step === 'green_light') {
        const arm = (await db.query('select status from core.arm where id = $1', [act.arm_id])).rows[0];
        if (arm?.status !== 'active') throw new HttpError(409, 'arm_not_active', 'green light only for an active arm');
      }
      await db.query(`update core.site_arm_activation set ${step}_at = coalesce($2::timestamptz, clock_timestamp()) where id = $1`,
        [act.id, body.at ?? null]);
      const out = (await getActivation(db, act.id))!;
      return { ...out, next_step: nextStep(out) };
    } }),
];
