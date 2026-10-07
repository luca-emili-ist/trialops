// Links TrialOps people to Supabase Auth users (core.person.idp_sub = auth.users.id), so that the claims hook can build
// their token. Synthetic demo users only, plus the single admin account (house rule: one login for every app).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, and
//   demo:  DEMO_PASSWORD           -> creates/links every person whose idp_sub starts with 'demo|'
//   admin: ADMIN_EMAIL, ADMIN_PASSWORD -> creates/links the admin as platform_admin of PLAT-001
// Usage: node scripts/supabase-users.mjs demo|admin   (secrets come from the environment, never printed)
import pg from 'pg';

const mode = process.argv[2];
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL) { console.error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL'); process.exit(1); }
const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' };

async function ensureUser(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, { method: 'POST', headers, body: JSON.stringify({ email, password, email_confirm: true }) });
  if (r.ok) return (await r.json()).id;
  // already there: find it and reset the password to the requested one
  for (let page = 1; page < 20; page++) {
    const l = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers })).json();
    const u = (l.users ?? []).find(x => x.email?.toLowerCase() === email.toLowerCase());
    if (u) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: 'PUT', headers, body: JSON.stringify({ password }) });
      return u.id;
    }
    if (!l.users?.length) break;
  }
  throw new Error(`could not create or find ${email}: ${r.status} ${await r.text()}`);
}

const c = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');
await c.query("select set_config('trialops.change_reason', 'link person to Supabase Auth user', true), set_config('trialops.actor', 'system:supabase-users', true)");
if (mode === 'demo') {
  if (!process.env.DEMO_PASSWORD) { console.error('missing DEMO_PASSWORD'); process.exit(1); }
  const people = (await c.query("select id, email, idp_sub from core.person where idp_sub like 'demo|%' or email like '%@demo.trialops.example' order by email")).rows;
  for (const p of people) {
    const id = await ensureUser(p.email, process.env.DEMO_PASSWORD);
    if (p.idp_sub !== id) await c.query('update core.person set idp_sub = $2 where id = $1', [p.id, id]);
  }
  console.log(`linked ${people.length} demo users`);
} else if (mode === 'admin') {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) { console.error('missing ADMIN_EMAIL / ADMIN_PASSWORD'); process.exit(1); }
  const uid = await ensureUser(ADMIN_EMAIL, ADMIN_PASSWORD);
  const org = (await c.query("select id from core.organization where name = 'InSilicoTrials Technologies'")).rows[0].id;
  const plat = (await c.query("select id from core.platform where code = 'PLAT-001'")).rows[0].id;
  let person = (await c.query('select id from core.person where email = $1', [ADMIN_EMAIL])).rows[0]?.id;
  if (!person) person = (await c.query("insert into core.person(org_id, idp_sub, full_name, email) values ($1,$2,'Luca Emili',$3) returning id", [org, uid, ADMIN_EMAIL])).rows[0].id;
  else await c.query('update core.person set idp_sub = $2 where id = $1', [person, uid]);
  const has = (await c.query("select 1 from core.role_assignment where person_id = $1 and role = 'platform_admin' and status = 'active'", [person])).rowCount;
  if (!has) await c.query("insert into core.role_assignment(person_id, role, platform_id) values ($1, 'platform_admin', $2)", [person, plat]);
  console.log(`admin ${ADMIN_EMAIL} linked as platform_admin of PLAT-001`);
} else { console.error('usage: demo|admin'); process.exit(1); }
await c.query('commit');
await c.end();
