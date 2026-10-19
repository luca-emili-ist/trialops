// Platform-level reads: health, current user, platforms and the platform overview behind the dashboard.
import { route } from '../route.ts';
import { mfaStatus } from '../lib/access-policy.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { HttpError } from '../errors.ts';

export const platformRoutes = [
  route({ method: 'get', path: '/v1/health', summary: 'Liveness, and the data region of this deployment and of its database (NFR-06)', tag: 'system',
    reqs: ['NFR-06'], public: true,
    handler: async ({ services }) => {
      // liveness first: a database that cannot be reached leaves the region unknown, it does not fail the health check
      const region = services.regionGate ? await services.regionGate.status().catch(() => null) : null;
      return { status: region && !region.ok ? 'region_misconfigured' : 'ok', region };
    } }),

  route({ method: 'get', path: '/v1/region', summary: 'Data region served by this deployment and the platforms of the caller in it (NFR-06)', tag: 'system',
    reqs: ['NFR-06'],
    handler: async ({ db, services }) => {
      if (!services.regionGate) throw new HttpError(501, 'region_unavailable', 'region gate not configured');
      const st = await services.regionGate.status();
      const platforms = (await db.query(`select id, code, data_region from core.platform where status <> 'void' order by code`)).rows;
      return { ...st, pinned: st.deployment_region !== null, platforms };
    } }),

  route({ method: 'get', path: '/v1/region/refusals', summary: 'Requests refused because they named a platform of another region (QA auditors, platform admins)',
    tag: 'system', reqs: ['NFR-06'], query: { limit: { type: 'string', pattern: '^[0-9]{1,4}$' } },
    handler: async ({ db, claims, query }) => {
      requirePerson(claims, 'Reading the region refusals');
      requireRole(claims, ['qa_auditor', 'platform_admin'], 'Reading the region refusals');
      return { items: (await db.query('select * from core.region_refusal_search($1)', [Number(query.limit ?? 200)])).rows };
    } }),

  // Reachable before the MFA step (aal1), so that the sign-in can show what is still needed (IAM-01).
  route({ method: 'get', path: '/v1/me', summary: 'Current identity and perimeter from the token, MFA status and session policy', tag: 'identity',
    reqs: ['APP-ID-02', 'IAM-02', 'NFR-06'], allowBelowMfa: true,
    handler: async ({ db, claims, access, services }) => {
      const person = claims.person_id
        ? (await db.query('select id, full_name, email, org_id from core.person where id = $1', [claims.person_id])).rows[0] ?? null
        : null;
      return {
        sub: claims.sub, email: claims.email ?? null, org_id: claims.org_id ?? null, actor_type: claims.actor_type ?? 'user',
        roles: claims.roles ?? [], platform_ids: claims.platform_ids ?? [], arm_scopes: claims.arm_scopes ?? [],
        site_scopes: claims.site_scopes ?? [], blinding: claims.blinding ?? 'blinded', person,
        mfa: mfaStatus(claims, access), session: { idle_timeout_minutes: access.idleMinutes },
        deployment_region: services.regionGate?.region ?? null,
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
