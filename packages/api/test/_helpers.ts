// Test harness: real Platform API on a random port, real PostgreSQL (DATABASE_URL from scripts/db.mjs),
// tokens built exactly like Supabase does (claims from core.custom_access_token_hook, HS256 test key).
import { SignJWT } from 'jose';
import pg from 'pg';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, createPool, createVerifier } from '../src/index.ts';
import type { Services } from '../src/route.ts';
import type { Reauthenticator } from '../src/lib/reauth.ts';
import { HttpError } from '../src/errors.ts';

export const TEST_SECRET = 'trialops-test-secret-not-for-production-0000';
const key = new TextEncoder().encode(TEST_SECRET);

export const DEMO_PASSWORD = 'demo-password';
/** Test re-authentication: the demo password is accepted for any user that has an email in the token. */
export const testReauth: Reauthenticator = {
  async reauth(claims, { password }) {
    if (password !== DEMO_PASSWORD || !claims.email) throw new HttpError(401, 'reauth_failed', 'signature re-authentication failed');
    return 'reauth_password';
  },
};

export async function sign(claims: Record<string, unknown>, ttl = '10m'): Promise<string> {
  return new SignJWT({ aud: 'authenticated', ...claims }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(ttl).sign(key);
}

export interface Api {
  url: string;
  admin: pg.Client;
  tokenFor(sub: string): Promise<string>;
  call(method: string, path: string, opts?: { token?: string; as?: string; body?: unknown; reason?: string }): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

/** API tests commit for real, so each test file works on a throw-away clone of the seeded database. */
async function cloneDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = new URL(process.env.DATABASE_URL!);
  const source = base.pathname.slice(1);
  const name = `${source}_t${process.pid}`;
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

export async function startApi(services: Services = {}): Promise<Api> {
  const clone = await cloneDatabase();
  const pool = createPool(clone.url);
  const server: Server = createApp({ pool, verify: createVerifier({ TRIALOPS_JWT_SECRET: TEST_SECRET }), services: { reauth: testReauth, ...services } }).listen(0);
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = new pg.Client({ connectionString: clone.url });
  await admin.connect();
  const tokenFor = async (sub: string) => {
    const e = (await admin.query('select core.custom_access_token_hook($1::jsonb) e',
      [JSON.stringify({ user_id: sub, claims: { sub, role: 'authenticated' } })])).rows[0].e;
    return sign(e.claims);
  };
  const call: Api['call'] = async (method, path, opts = {}) => {
    const token = opts.token ?? (opts.as ? await tokenFor(opts.as) : undefined);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.reason) headers['x-change-reason'] = opts.reason;
    const res = await fetch(url + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    url, admin, tokenFor, call,
    close: async () => { await new Promise(r => server.close(r)); await pool.end(); await admin.end(); await clone.drop(); },
  };
}

export async function platformId(admin: pg.Client): Promise<string> {
  return (await admin.query("select id from core.platform where code = 'PLAT-001'")).rows[0].id;
}
