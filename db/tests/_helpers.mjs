import pg from 'pg';
export async function db() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  return c;
}
// Run fn inside a transaction that is always rolled back, optionally as an API role with JWT claims.
export async function tx(c, fn, { role, claims, reason } = {}) {
  await c.query('begin');
  try {
    if (claims) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    if (reason) await c.query("select set_config('trialops.change_reason', $1, true)", [reason]);
    if (role) await c.query(`set local role ${role}`);
    return await fn(c);
  } finally { await c.query('rollback'); }
}
export async function ids(c) {
  const p = (await c.query("select id from core.platform where code='PLAT-001'")).rows[0].id;
  const arms = Object.fromEntries((await c.query('select code, id from core.arm where platform_id=$1', [p])).rows.map(r => [r.code, r.id]));
  const sites = (await c.query('select id from core.site where platform_id=$1 order by site_number', [p])).rows.map(r => r.id);
  return { platform: p, arms, sites };
}
export async function rejects(promise, re) {
  try { await promise; } catch (e) { if (re && !re.test(e.message)) throw new Error(`wrong error: ${e.message}`); return e; }
  throw new Error('expected an error, none thrown');
}
