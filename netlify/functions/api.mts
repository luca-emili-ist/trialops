// Netlify Function hosting the Platform API (decision 2026-10-06: Netlify Functions + Supabase).
// The Express app is started once per container on a loopback port and each request is forwarded to it, so the API
// code stays exactly the one tested locally. Secrets come only from the site environment (server-side).
import type { AddressInfo } from 'node:net';
import { createApp, createPool, createVerifier } from '../../packages/api/src/index.ts';
import { createOidc } from '../../packages/api/src/lib/oidc.ts';
import { supabaseReauth } from '../../packages/api/src/lib/reauth.ts';
import { createAiRuntime } from '../../services/ai-runtime/src/index.ts';

const env = process.env;
let base: Promise<string> | null = null;

async function start(): Promise<string> {
  const issuer = (env.TRIALOPS_ISSUER ?? env.URL ?? '').replace(/\/$/, '');
  const app = createApp({
    pool: createPool(env.DATABASE_URL),
    verify: createVerifier(env),
    services: {
      ai: createAiRuntime(),
      reauth: supabaseReauth(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY!),
      oidc: await createOidc({ issuer, authorizeUrl: `${issuer}/#/oidc/authorize`, privateJwk: env.TRIALOPS_OIDC_PRIVATE_JWK }),
    },
  });
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

export default async (req: Request): Promise<Response> => {
  base ??= start();
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete('host');
  const res = await fetch(`${await base}${url.pathname}${url.search}`, {
    method: req.method, headers, redirect: 'manual',
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
};

export const config = { path: ['/v1/*', '/api/*', '/oidc/*', '/.well-known/*'] };
