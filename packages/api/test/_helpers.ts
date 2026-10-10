// Test harness: real Platform API on a random port, real PostgreSQL (DATABASE_URL from scripts/db.mjs),
// tokens built exactly like Supabase does (claims from core.custom_access_token_hook, HS256 test key).
import { SignJWT } from 'jose';
import pg from 'pg';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, createPool, createVerifier } from '../src/index.ts';
import type { Services } from '../src/route.ts';
import { randomUUID } from 'node:crypto';
import { providerReauth } from '../src/lib/reauth.ts';
import { createOidc } from '../src/lib/oidc.ts';
import { localAuth } from '../src/lib/local-auth.ts';
import type { AuthFactor } from '../src/lib/auth-provider.ts';
import { accessConfigFromEnv, type AccessConfig } from '../src/lib/access-policy.ts';

export const TEST_SECRET = 'trialops-test-secret-not-for-production-0000';
const key = new TextEncoder().encode(TEST_SECRET);

export const DEMO_PASSWORD = 'demo-password';
/** Fixed one-time code of the test authenticator (IAM-01): every synthetic user has one verified TOTP factor unless a test
 * changes it with Api.factors. */
export const TEST_TOTP = '123456';
/** Credential of a signature in the tests: password + authenticator code (MFA step-up). */
export const SIGN = { password: DEMO_PASSWORD, totp: TEST_TOTP };

export async function sign(claims: Record<string, unknown>, ttl = '10m'): Promise<string> {
  return new SignJWT({ aud: 'authenticated', ...claims }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(ttl).sign(key);
}

export interface Api {
  url: string;
  admin: pg.Client;
  /** Token of a synthetic user as Supabase issues it after the MFA step: aal2, one stable session per user. */
  tokenFor(sub: string, extra?: Record<string, unknown>): Promise<string>;
  /** Calls made to the (local) identity provider so far. */
  idpCalls(): number;
  /** TOTP factors per subject at the identity provider (default: one verified factor `totp-<sub>`). */
  factors: Map<string, AuthFactor[]>;
  call(method: string, path: string, opts?: { token?: string; as?: string; body?: unknown; reason?: string }): Promise<{ status: number; body: any }>;
  /** Starts an AI job (POST answering 202) and polls GET /v1/ai/jobs/{id} until it ends; returns the 202 and the final job. */
  job(method: string, path: string, opts?: { token?: string; as?: string; body?: unknown }): Promise<{ accepted: { status: number; body: any }; job: any }>;
  close(): Promise<void>;
}

let clones = 0;
/** API tests commit for real, so each test file works on a throw-away clone of the seeded database. */
async function cloneDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = new URL(process.env.DATABASE_URL!);
  const source = base.pathname.slice(1);
  const name = `${source}_t${process.pid}_${++clones}`;
  const maint = new URL(base); maint.pathname = '/postgres';
  const m = new pg.Client({ connectionString: maint.toString() });
  await m.connect();
  await m.query(`drop database if exists ${name}`);
  await m.query(`create database ${name} template ${source}`);
  await m.end();
  const url = new URL(base); url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const d = new pg.Client({ connectionString: maint.toString() });
      await d.connect(); await d.query(`drop database if exists ${name} with (force)`); await d.end();
    },
  };
}

/** Access policy of the tests: the defaults of production (MFA required, 5 failures / 15 min, 30 min lock, 15 min idle). */
export const TEST_ACCESS: AccessConfig = accessConfigFromEnv({});

export async function startApi(services: Services = {}, opts: { access?: Partial<AccessConfig> } = {}): Promise<Api> {
  const clone = await cloneDatabase();
  const pool = createPool(clone.url);
  const admin = new pg.Client({ connectionString: clone.url });
  await admin.connect();
  const sessions = new Map<string, string>();
  const factors = new Map<string, AuthFactor[]>();
  const hookClaims = async (sub: string) => (await admin.query('select core.custom_access_token_hook($1::jsonb) e',
    [JSON.stringify({ user_id: sub, claims: { sub, role: 'authenticated' } })])).rows[0].e.claims;
  const tokenFor = async (sub: string, extra: Record<string, unknown> = {}) => {
    if (!sessions.has(sub)) sessions.set(sub, randomUUID());
    return sign({ ...(await hookClaims(sub)), aal: 'aal2', amr: [{ method: 'password' }, { method: 'totp' }], session_id: sessions.get(sub), ...extra });
  };
  const idp = localAuth({
    lookup: async email => (await admin.query('select idp_sub from core.person where lower(email) = $1', [email])).rows[0]?.idp_sub ?? null,
    mint: async (sub, extra) => sign({ ...(await hookClaims(sub)), ...extra }),
    password: DEMO_PASSWORD, totp: TEST_TOTP,
    factorsFor: (sub): AuthFactor[] => factors.get(sub) ?? [{ id: `totp-${sub}`, factor_type: 'totp', status: 'verified' }],
  });
  const svc: Services = { auth: idp, reauth: providerReauth(services.auth ?? idp), access: { ...TEST_ACCESS, ...opts.access }, ...services };
  const server: Server = createApp({ pool, verify: createVerifier({ TRIALOPS_JWT_SECRET: TEST_SECRET }), services: svc }).listen(0);
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  svc.oidc ??= await createOidc({ issuer: url });   // issuer = this test server, ephemeral key
  const call: Api['call'] = async (method, path, opts = {}) => {
    const token = opts.token ?? (opts.as ? await tokenFor(opts.as) : undefined);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.reason) headers['x-change-reason'] = opts.reason;
    const res = await fetch(url + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const job: Api['job'] = async (method, path, opts = {}) => {
    const token = opts.token ?? (opts.as ? await tokenFor(opts.as) : undefined);
    const accepted = await call(method, path, { ...opts, token });
    let j = accepted.body;
    for (let i = 0; accepted.status === 202 && ['queued', 'running'].includes(j.status) && i < 400; i++) {
      await new Promise(r => setTimeout(r, 25));
      j = (await call('GET', `/v1/ai/jobs/${j.id}`, { token })).body;
    }
    return { accepted, job: j };
  };
  return {
    url, admin, tokenFor, call, job, idpCalls: () => idp.calls, factors,
    close: async () => { await new Promise(r => server.close(r)); await pool.end(); await admin.end(); await clone.drop(); },
  };
}

export async function platformId(admin: pg.Client): Promise<string> {
  return (await admin.query("select id from core.platform where code = 'PLAT-001'")).rows[0].id;
}
