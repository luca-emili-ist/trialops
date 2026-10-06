// Minimal TA1 test app server. TRIALOPS_ISSUER, TA1_PLATFORM_ID, TA1_REDIRECT_URI (must be registered in the manifest).
// Run: node examples/ta1-test-app/src/server.ts — then open /login.
import { createServer } from 'node:http';
import { discover, loginRequest, completeLogin, type LoginRequest } from './client.ts';

const issuer = process.env.TRIALOPS_ISSUER ?? 'http://localhost:8787';
const redirectUri = process.env.TA1_REDIRECT_URI ?? 'https://localhost:5174/callback';
const platformId = process.env.TA1_PLATFORM_ID ?? '';
const pending = new Map<string, LoginRequest>();
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const meta = await discover(issuer);
    if (url.pathname === '/login') {
      const login = loginRequest(meta, redirectUri, platformId);
      pending.set(login.state, login);
      res.writeHead(302, { location: login.url }).end();
    } else if (url.pathname === '/callback') {
      const login = pending.get(url.searchParams.get('state') ?? '');
      if (!login) { res.writeHead(400).end('unknown state'); return; }
      pending.delete(login.state);
      const { identity } = await completeLogin(meta, redirectUri, url.searchParams.get('code') ?? '', login);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>TA1 test app</title>
        <h1>TA1 test app</h1><p>Signed in through TrialOps as <b>${esc(identity.email)}</b> (no password entered here).</p>
        <pre>${esc(JSON.stringify({ sub: identity.sub, roles: identity.roles, platform_ids: identity.platform_ids,
          arm_scopes: identity.arm_scopes, blinding: identity.blinding }, null, 2))}</pre>`);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<a href="/login">Sign in with TrialOps</a>');
    }
  } catch (e) { res.writeHead(500).end(esc((e as Error).message)); }
}).listen(Number(process.env.PORT ?? 5174), () => console.log('TA1 test app on :' + (process.env.PORT ?? 5174)));
