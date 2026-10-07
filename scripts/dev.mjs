// Local development stack in one process: embedded PostgreSQL (kept running), Platform API on :8787 with the AI runtime
// in replay mode, an ephemeral OIDC key, the demo user switch and a test re-authentication (password "demo-password").
// Synthetic data only. Usage: npm run dev:api   (then npm run dev:web in another terminal)
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SignJWT } from 'jose';
import { createApp, createPool, createVerifier } from '../packages/api/src/index.ts';
import { createOidc } from '../packages/api/src/lib/oidc.ts';
import { HttpError } from '../packages/api/src/errors.ts';
import { createAiRuntime } from '../services/ai-runtime/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.TRIALOPS_PGDATA || join(root, '.pgdata');
const port = Number(process.env.TRIALOPS_PGPORT || 54329);
const apiPort = Number(process.env.PORT || 8787);
const secret = 'trialops-local-dev-secret-not-for-production';

if (!existsSync(join(dataDir, 'PG_VERSION'))) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/db.mjs'), 'reset'], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
}
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: true, onLog: () => {} });
await server.start();
const url = `postgres://postgres:postgres@localhost:${port}/trialops`;
const admin = new pg.Client({ connectionString: url });
await admin.connect();

const key = new TextEncoder().encode(secret);
const devLogin = async sub => {
  const e = (await admin.query('select core.custom_access_token_hook($1::jsonb) e', [JSON.stringify({ user_id: sub, claims: { sub, role: 'authenticated' } })])).rows[0].e;
  return new SignJWT({ aud: 'authenticated', ...e.claims }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('8h').sign(key);
};
const issuer = process.env.TRIALOPS_ISSUER || `http://localhost:${apiPort}`;
const services = {
  ai: createAiRuntime(),
  oidc: await createOidc({ issuer, authorizeUrl: `${process.env.TRIALOPS_WEB_URL || 'http://localhost:5173'}/#/oidc/authorize` }),
  reauth: { async reauth(claims, { password }) {
    if (password !== 'demo-password' || !claims.email) throw new HttpError(401, 'reauth_failed', 'signature re-authentication failed');
    return 'reauth_password';
  } },
  ...(process.env.TRIALOPS_DEV_LOGIN === '1' ? { devLogin, devUsers: async () => (await admin.query(`select p.idp_sub sub, p.full_name, o.name org,
      coalesce((select string_agg(distinct r.role, ', ') from core.role_assignment r where r.person_id = p.id and r.status = 'active'), '') roles
    from core.person p join core.organization o on o.id = p.org_id where p.idp_sub like 'demo|%' order by p.full_name`)).rows } : {}),
};
const app = createApp({ pool: createPool(url), verify: createVerifier({ TRIALOPS_JWT_SECRET: secret }), services });
app.listen(apiPort, () => console.log(`TrialOps API http://localhost:${apiPort} (db ${port}, AI ${services.ai.provider.name}, dev login ${services.devLogin ? 'on' : 'off'})`));
const stop = async () => { await admin.end().catch(() => {}); await server.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
