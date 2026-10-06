// Agents act under their own service identity (IAM-07): actor_type 'agent', never unblinded, perimeter limited to the
// platform and arm of the task they execute. Inside the request transaction the claims are switched for the agent's
// steps, so audit rows, task events and ledger rows name the agent, not the person who started it.
import type { Db } from '../db.ts';
import type { Claims } from '../auth.ts';

export function agentClaims(agentId: string, platformId: string, armId: string | null): Claims {
  return { sub: `agent:${agentId}`, actor_type: 'agent', blinding: 'blinded', roles: [], platform_ids: [platformId],
    arm_scopes: armId ? [armId] : '*', site_scopes: '*' };
}

export async function asActor<T>(db: Db, claims: Claims, fn: () => Promise<T>): Promise<T> {
  const prev = (await db.query("select current_setting('request.jwt.claims', true) c")).rows[0]?.c ?? '';
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  try { return await fn(); } finally { await db.query("select set_config('request.jwt.claims', $1, true)", [prev]); }
}
