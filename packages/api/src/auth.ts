// Bearer token verification. Tokens are issued by Supabase Auth, enriched by core.custom_access_token_hook
// (APP-ID-02), or by the TrialOps OIDC provider for apps. The API trusts only verified claims.
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import { HttpError } from './errors.ts';

export interface Claims extends JWTPayload {
  sub: string;
  email?: string;
  org_id?: string;
  person_id?: string;
  platform_ids?: string[];
  arm_scopes?: string[] | '*';
  site_scopes?: string[] | '*';
  roles?: string[];
  blinding?: 'blinded' | 'unblinded';
  actor_type?: 'user' | 'agent' | 'app' | 'anon' | 'system';
  app_id?: string;
  /** Supabase Auth: authenticator assurance level (aal2 = second factor verified, IAM-01) and session id (CMP-03). */
  aal?: string;
  amr?: { method: string; timestamp?: number }[];
  session_id?: string;
}

export type Verifier = (token: string) => Promise<Claims>;

/**
 * TRIALOPS_JWKS_URL: asymmetric keys (Supabase .../auth/v1/.well-known/jwks.json).
 * TRIALOPS_JWT_SECRET: shared HS256 secret (legacy Supabase projects, local dev and tests).
 */
export function createVerifier(env: NodeJS.ProcessEnv = process.env): Verifier {
  const audience = env.TRIALOPS_JWT_AUDIENCE || 'authenticated';
  const opts = { audience, issuer: env.TRIALOPS_JWT_ISSUER || undefined };
  let verify: (t: string) => Promise<JWTPayload>;
  if (env.TRIALOPS_JWKS_URL) {
    const jwks = createRemoteJWKSet(new URL(env.TRIALOPS_JWKS_URL));
    verify = async t => (await jwtVerify(t, jwks, opts)).payload;
  } else if (env.TRIALOPS_JWT_SECRET) {
    const key = new TextEncoder().encode(env.TRIALOPS_JWT_SECRET);
    verify = async t => (await jwtVerify(t, key, { ...opts, algorithms: ['HS256'] })).payload;
  } else {
    throw new Error('set TRIALOPS_JWKS_URL or TRIALOPS_JWT_SECRET');
  }
  return async token => {
    let p: JWTPayload;
    try { p = await verify(token); } catch { throw new HttpError(401, 'invalid_token', 'Bearer token is invalid or expired'); }
    if (!p.sub) throw new HttpError(401, 'invalid_token', 'token has no subject');
    // IAM-07: agents and apps are never unblinded, whatever the token says.
    if (p.actor_type === 'agent' || p.actor_type === 'app') p.blinding = 'blinded';
    return p as Claims;
  };
}

export function bearer(header: string | undefined): string {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m?.[1]) throw new HttpError(401, 'missing_token', 'Authorization: Bearer <token> required');
  return m[1];
}
