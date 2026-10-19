// Regions (NFR-06, rule 15): one deployment serves one data region. The same code runs in the EU, US and JP deployments
// (one Supabase project + one Netlify site each, docs/compliance/REGIONS.md); TRIALOPS_DEPLOYMENT_REGION says which one
// this is. The gate below runs before every authenticated route:
//   * the database must serve the same region (core.deployment_region(), 0028), otherwise nothing is served (503);
//   * a request that names a platform of another region (path /v1/platforms/:id, platform_id in the query or the body) is
//     refused with 403 wrong_region (not 421: HTTP clients retry a 421 on a new connection) and recorded in
//     core.region_access_refusal (append-only, audited) in its own transaction, because the request transaction is rolled back;
//   * the platform perimeter of the token is narrowed to the platforms of this region, so RLS hides every record of a
//     platform of another region from every other route (fail closed).
// Without TRIALOPS_DEPLOYMENT_REGION the API is not region-pinned (local development, tests, the transitional demo): it
// serves every platform of its database, but still refuses a database that declares a region.
import type pg from 'pg';
import type { Claims } from '../auth.ts';
import { withClaims } from '../db.ts';
import { HttpError } from '../errors.ts';

export type Region = 'EU' | 'US' | 'JP';
export const REGIONS: readonly Region[] = ['EU', 'US', 'JP'];

/** TRIALOPS_DEPLOYMENT_REGION: EU, US or JP; empty = not pinned. Any other value stops the start-up. */
export function regionFromEnv(env: NodeJS.ProcessEnv = process.env): Region | null {
  const v = env.TRIALOPS_DEPLOYMENT_REGION?.trim().toUpperCase();
  if (!v) return null;
  if (!(REGIONS as readonly string[]).includes(v)) throw new Error(`TRIALOPS_DEPLOYMENT_REGION must be EU, US or JP (got "${v}")`);
  return v as Region;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Platforms a request names explicitly: the :id of /v1/platforms/:id routes, platform_id in the query or the body. */
export function requestedPlatforms(routePath: string, params: Record<string, string>, query: Record<string, unknown>, body: unknown): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && UUID.test(v)) out.add(v.toLowerCase()); };
  if (routePath.startsWith('/v1/platforms/:id')) add(params.id);
  add(query.platform_id);
  if (body && typeof body === 'object' && !Array.isArray(body)) add((body as Record<string, unknown>).platform_id);
  return [...out];
}

interface PlatformRegion { id: string; code: string; data_region: Region | null }

export interface RegionStatus { deployment_region: Region | null; database_region: Region | null; ok: boolean; problem: string | null }

export class RegionGate {
  /** Regions of platforms already seen. Only set regions are kept: a data region is set once and never changes (0026). */
  private readonly known = new Map<string, PlatformRegion>();
  private database: Promise<Region | null> | undefined;

  private readonly pool: pg.Pool;
  readonly region: Region | null;
  constructor(pool: pg.Pool, region: Region | null) { this.pool = pool; this.region = region; }

  /** Region declared by the database (read once per process; it is set once and never changes). */
  databaseRegion(): Promise<Region | null> {
    this.database ??= this.pool.query('select core.deployment_region() r').then(r => (r.rows[0]?.r ?? null) as Region | null,
      e => {
        this.database = undefined;
        // a database without 0028 has no region of its own: acceptable only for an API that is not region-pinned
        if ((e as { code?: string }).code === '42883' && !this.region) return null;
        throw e;
      });
    return this.database;
  }

  async status(): Promise<RegionStatus> {
    const db = await this.databaseRegion();
    const problem = db && db !== this.region
      ? `this database serves ${db}, the API is configured for ${this.region ?? 'no region'} (TRIALOPS_DEPLOYMENT_REGION, NFR-06)` : null;
    return { deployment_region: this.region, database_region: db, ok: !problem, problem };
  }

  private async lookup(claims: Claims, ids: string[] | null): Promise<PlatformRegion[]> {
    if (ids && ids.every(id => this.known.has(id))) return ids.map(id => this.known.get(id)!);
    const rows = await withClaims(this.pool, claims, undefined, async db =>
      (await db.query('select id, code, data_region from core.platform_regions($1)', [ids])).rows as PlatformRegion[]);
    for (const r of rows) if (r.data_region) this.known.set(r.id, r);
    return rows;
  }

  /**
   * Applies the region rules to an authenticated request: returns the claims with the platform perimeter narrowed to this
   * region, or throws (503 when the database serves another region, 403 wrong_region for a platform of another region).
   */
  async enforce(claims: Claims, request: { method: string; path: string; platforms: string[] }): Promise<Claims> {
    const st = await this.status();
    if (!st.ok) throw new HttpError(503, 'region_misconfigured', st.problem!);
    const region = this.region;
    if (!region) return claims;
    const own = Array.isArray(claims.platform_ids) ? claims.platform_ids.map(p => p.toLowerCase()) : null;
    const asked = request.platforms.filter(p => !own?.includes(p));
    const rows = await this.lookup(claims, own ? [...own, ...asked] : null);
    const extra = asked.length && !own ? await this.lookup(claims, asked) : [];
    const byId = new Map([...rows, ...extra].map(r => [r.id, r]));
    // A platform of another region asked for explicitly: refused and recorded.
    for (const id of request.platforms) {
      const p = byId.get(id);
      if (p?.data_region && p.data_region !== region) {
        await withClaims(this.pool, claims, undefined, db => db.query('select core.log_region_refusal($1, $2, $3, $4, $5)',
          [region, p.id, p.data_region, request.method.toUpperCase(), request.path.slice(0, 500)]));
        throw new HttpError(403, 'wrong_region', `platform ${p.code} keeps its data in ${p.data_region}; this deployment serves ${region}. ` +
          `Use the ${p.data_region} deployment (NFR-06)`);
      }
    }
    // Perimeter of the token narrowed to this region: RLS then hides the records of other regions everywhere.
    const base = own ?? rows.map(r => r.id);
    const inRegion = base.filter(id => { const p = byId.get(id); return !p?.data_region || p.data_region === region; });
    if (own && inRegion.length === own.length) return claims;
    return { ...claims, platform_ids: inRegion };
  }
}
