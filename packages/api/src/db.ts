// Every request runs in its own transaction, as the database role of the caller with its JWT claims, so the RLS
// policies, audit triggers and state machines of the migrations stay the only enforcement point (IAM-02).
import pg from 'pg';
import type { Claims } from './auth.ts';

export type Db = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString, max: Number(process.env.TRIALOPS_DB_POOL || 5) });
}

/** Database role for a caller: apps use app_service, people and agents authenticated, public endpoints anon.
 * Never a privileged role. */
export function dbRole(claims: Claims): 'authenticated' | 'app_service' | 'anon' {
  return claims.actor_type === 'app' ? 'app_service' : claims.actor_type === 'anon' ? 'anon' : 'authenticated';
}
export const ANONYMOUS: Claims = { sub: 'anonymous', actor_type: 'anon' };

/** settings: further transaction-local settings, e.g. trialops.provenance of an app write (APP-DT-05). */
export async function withClaims<T>(pool: pg.Pool, claims: Claims, reason: string | undefined, fn: (db: Db) => Promise<T>,
  settings: Record<string, string> = {}): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    if (reason) await client.query("select set_config('trialops.change_reason', $1, true)", [reason]);
    for (const [k, v] of Object.entries(settings)) await client.query('select set_config($1, $2, true)', [k, v]);
    await client.query(`set local role ${dbRole(claims)}`);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** A database row as returned by pg (columns are not statically typed). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
