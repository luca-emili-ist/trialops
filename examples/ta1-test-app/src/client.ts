// OIDC relying-party side of the TA1 test app: authorization code + PKCE against TrialOps, ID token verified with the
// TrialOps JWKS. The app never handles a password (APP-ID-01).
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export const CLIENT_ID = 'ist.ta1-test-app';

export interface ProviderMetadata { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint: string }

export async function discover(issuer: string): Promise<ProviderMetadata> {
  const r = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`discovery failed: ${r.status}`);
  return r.json() as Promise<ProviderMetadata>;
}

export interface LoginRequest { url: string; verifier: string; state: string; nonce: string; challenge: string }

/** Where to send the browser: the TrialOps shell, which signs in the user (if needed) and redirects back with a code. */
export function loginRequest(meta: ProviderMetadata, redirectUri: string, platformId: string): LoginRequest {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const nonce = randomBytes(16).toString('base64url');
  const u = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri, scope: 'openid email',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', platform_id: platformId })) u.searchParams.set(k, v);
  return { url: u.toString(), verifier, state, nonce, challenge };
}

export interface TrialOpsIdentity extends JWTPayload {
  email?: string; org_id?: string; platform_ids?: string[]; arm_scopes?: string[] | '*'; site_scopes?: string[] | '*';
  roles?: string[]; blinding?: 'blinded' | 'unblinded'; nonce?: string;
}

/** Exchanges the code and returns the verified identity carried by the ID token. */
export async function completeLogin(meta: ProviderMetadata, redirectUri: string, code: string, login: LoginRequest)
  : Promise<{ identity: TrialOpsIdentity; access_token: string }> {
  const res = await fetch(meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: login.verifier }),
  });
  const body = await res.json() as { id_token?: string; access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.id_token) throw new Error(`token exchange failed: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim());
  const { payload } = await jwtVerify(body.id_token, createRemoteJWKSet(new URL(meta.jwks_uri)), { issuer: meta.issuer, audience: CLIENT_ID });
  if (payload.nonce !== login.nonce) throw new Error('nonce mismatch');
  return { identity: payload as TrialOpsIdentity, access_token: body.access_token! };
}
