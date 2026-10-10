// Shared bootstrap of the Netlify functions (decision 2026-10-06: Netlify Functions + Supabase). The Express app is
// started once per container on a loopback port and each request is forwarded to it, so the API code stays exactly the
// one tested locally. Secrets come only from the site environment (server-side).
import type { AddressInfo } from 'node:net';
import { createApp, createPool, createVerifier, type JobDispatcher } from '../../packages/api/src/index.ts';
import { createOidc } from '../../packages/api/src/lib/oidc.ts';
import { providerReauth } from '../../packages/api/src/lib/reauth.ts';
import { supabaseAuth } from '../../packages/api/src/lib/auth-provider.ts';
import { createAiRuntime } from '../../services/ai-runtime/src/index.ts';

const env = process.env;
let base: Promise<string> | null = null;

/** Hands a queued AI job to the background function (202 at once, up to 15 minutes of work). The person's bearer token
 * and the Team login cookie are forwarded so the worker runs as that person and passes the site protection. */
export function backgroundDispatcher(workerUrl = env.TRIALOPS_WORKER_URL
  ?? (env.URL ? `${env.URL.replace(/\/$/, '')}/.netlify/functions/ai-worker-background` : undefined)): JobDispatcher {
  return {
    async dispatch(jobId, { authorization, cookie }) {
      if (!workerUrl) throw new Error('worker URL unknown: set TRIALOPS_WORKER_URL or URL');
      const res = await fetch(workerUrl, { method: 'POST', redirect: 'manual', body: JSON.stringify({ job_id: jobId }), headers: {
        'content-type': 'application/json', ...(authorization ? { authorization } : {}), ...(cookie ? { cookie } : {}) } });
      if (res.status !== 202 && res.status !== 200) throw new Error(`worker answered ${res.status}`);
    },
  };
}

async function start(): Promise<string> {
  const issuer = (env.TRIALOPS_ISSUER ?? env.URL ?? '').replace(/\/$/, '');
  // Sign-in, MFA verification and signature re-authentication against Supabase Auth (IAM-01, CMP-03). Access policy from
  // TRIALOPS_MFA, TRIALOPS_MFA_EXEMPT_EMAIL_DOMAINS, TRIALOPS_LOCKOUT_*, TRIALOPS_IDLE_MINUTES (lib/access-policy.ts).
  const auth = supabaseAuth(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY!);
  const app = createApp({
    pool: createPool(env.DATABASE_URL),
    verify: createVerifier(env),
    services: {
      ai: createAiRuntime(),
      jobs: backgroundDispatcher(),
      auth,
      reauth: providerReauth(auth),
      oidc: await createOidc({ issuer, authorizeUrl: `${issuer}/#/oidc/authorize`, privateJwk: env.TRIALOPS_OIDC_PRIVATE_JWK }),
    },
  });
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

/** Forwards a request to the in-container Platform API. */
export async function forward(path: string, init: { method: string; headers: Headers; body?: ArrayBuffer }): Promise<Response> {
  base ??= start();
  init.headers.delete('host');
  const res = await fetch(`${await base}${path}`, { method: init.method, headers: init.headers, redirect: 'manual', body: init.body });
  return new Response(res.body, { status: res.status, headers: res.headers });
}
