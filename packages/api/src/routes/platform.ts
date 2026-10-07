// Platform-level reads: health, current user, platforms and the platform overview behind the dashboard.
import { route } from '../route.ts';

export const platformRoutes = [
  route({ method: 'get', path: '/v1/health', summary: 'Liveness', tag: 'system', reqs: [], public: true,
    handler: async () => ({ status: 'ok' }) }),

  route({ method: 'get', path: '/v1/me', summary: 'Current identity and perimeter from the token', tag: 'identity', reqs: ['APP-ID-02', 'IAM-02'],
    handler: async ({ db, claims }) => {
      const person = claims.person_id
        ? (await db.query('select id, full_name, email, org_id from core.person where id = $1', [claims.person_id])).rows[0] ?? null
        : null;
      return {
        sub: claims.sub, email: claims.email ?? null, org_id: claims.org_id ?? null, actor_type: claims.actor_type ?? 'user',
        roles: claims.roles ?? [], platform_ids: claims.platform_ids ?? [], arm_scopes: claims.arm_scopes ?? [],
        site_scopes: claims.site_scopes ?? [], blinding: claims.blinding ?? 'blinded', person,
      };
    } }),

  route({ method: 'get', path: '/v1/platforms', summary: 'Platforms visible to the caller', tag: 'platform', reqs: ['IAM-02'],
    handler: async ({ db }) => ({
      items: (await db.query(`select p.id, p.code, p.title, p.therapeutic_area, p.status, o.name lead_operator
        from core.platform p join core.organization o on o.id = p.lead_operator_id where p.status <> 'void' order by p.code`)).rows,
    }) }),

  route({ method: 'get', path: '/v1/platforms/:id', summary: 'Platform overview: arms, sites, enrollment, open tasks', tag: 'platform',
    reqs: ['IAM-02', 'IAM-03'],
    handler: async ({ db, params }) => {
      const p = (await db.query(`select p.id, p.code, p.title, p.therapeutic_area, p.status, o.name lead_operator
        from core.platform p join core.organization o on o.id = p.lead_operator_id where p.id = $1`, [params.id])).rows[0];
      if (!p) return undefined;
      const arms = (await db.query(`select a.id, a.code, a.name, a.status, a.current_stage, a.intervention_type, o.name sponsor
        from core.arm a left join core.organization o on o.id = a.sponsor_org_id
        where a.platform_id = $1 and a.status <> 'void' order by a.code`, [params.id])).rows;
      const sites = (await db.query(`select count(*)::int n, count(*) filter (where status = 'active')::int active
        from core.site where platform_id = $1 and status <> 'void'`, [params.id])).rows[0];
      const enrollment = (await db.query(`select coalesce(sum(identified),0)::int identified, coalesce(sum(prescreened),0)::int prescreened,
          coalesce(sum(consented),0)::int consented, coalesce(sum(randomized),0)::int randomized
        from core.v_enrollment_funnel where platform_id = $1`, [params.id])).rows[0];
      const tasks = (await db.query(`select count(*)::int open from core.task
        where platform_id = $1 and state not in ('completed','rejected','cancelled','expired')`, [params.id])).rows[0];
      return { ...p, arms, sites, enrollment, open_tasks: tasks.open };
    } }),

  route({ method: 'get', path: '/v1/platforms/:id/people', summary: 'People with an active role on the platform', tag: 'identity',
    reqs: ['IAM-02'],
    handler: async ({ db, params }) => ({
      items: (await db.query(`select p.id, p.full_name, p.email, o.name org, string_agg(distinct r.role, ', ' order by r.role) roles
        from core.person p join core.organization o on o.id = p.org_id
        join core.role_assignment r on r.person_id = p.id and r.status = 'active' and r.platform_id = $1
        where p.status = 'active' group by p.id, o.name order by p.full_name`, [params.id])).rows,
    }) }),
];
