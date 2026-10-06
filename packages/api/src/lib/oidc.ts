// TrialOps as OpenID Provider towards installed apps (APP-ID-01): authorization code + PKCE (S256), ID tokens signed
// with the TrialOps key and carrying the TrialOps claims (APP-ID-02). The signing key lives only server-side (env).
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, importJWK, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';
import { HttpError } from '../errors.ts';

export interface Oidc {
  issuer: string;
  authorizeUrl: string;            // the web shell page where a signed-in user is sent (SSO without a new login)
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
  ephemeral: boolean;
}

const ALG = 'ES256';

/**
 * TRIALOPS_OIDC_PRIVATE_JWK: the ES256 private JWK (secret, server-side only). Without it an ephemeral key is generated
 * (local development and tests only: tokens die with the process).
 */
export async function createOidc(env: { issuer: string; authorizeUrl?: string; privateJwk?: string }): Promise<Oidc> {
  let privateKey: CryptoKey; let publicJwk: JWK; let ephemeral = false;
  if (env.privateJwk) {
    const jwk = JSON.parse(env.privateJwk) as JWK;
    privateKey = await importJWK(jwk, ALG) as CryptoKey;
    const { d: _d, ...pub } = jwk;
    publicJwk = pub;
  } else {
    const pair = await generateKeyPair(ALG, { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
    ephemeral = true;
  }
  const kid = publicJwk.kid ?? createHash('sha256').update(JSON.stringify({ x: publicJwk.x, y: publicJwk.y })).digest('base64url').slice(0, 16);
  return { issuer: env.issuer.replace(/\/$/, ''), authorizeUrl: env.authorizeUrl ?? `${env.issuer.replace(/\/$/, '')}/oidc/authorize`,
    kid, privateKey, publicJwk: { ...publicJwk, kid, alg: ALG, use: 'sig' }, ephemeral };
}

export const newCode = (): string => randomBytes(32).toString('base64url');
export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

export async function signToken(o: Oidc, claims: Record<string, unknown>, aud: string, ttlSeconds = 300): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: ALG, kid: o.kid, typ: 'JWT' }).setIssuer(o.issuer).setAudience(aud)
    .setIssuedAt().setExpirationTime(`${ttlSeconds}s`).sign(o.privateKey);
}

export async function verifyAccessToken(o: Oidc, token: string): Promise<Record<string, unknown>> {
  try {
    return (await jwtVerify(token, await importJWK(o.publicJwk, ALG), { issuer: o.issuer, audience: `${o.issuer}/oidc/userinfo` })).payload;
  } catch {
    throw new HttpError(401, 'invalid_token', 'access token is invalid or expired');
  }
}

export function discovery(o: Oidc): Record<string, unknown> {
  return {
    issuer: o.issuer,
    authorization_endpoint: o.authorizeUrl,
    token_endpoint: `${o.issuer}/oidc/token`,
    userinfo_endpoint: `${o.issuer}/oidc/userinfo`,
    jwks_uri: `${o.issuer}/oidc/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [ALG],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['openid', 'email', 'profile'],
    claims_supported: ['sub', 'email', 'name', 'org_id', 'platform_ids', 'arm_scopes', 'site_scopes', 'roles', 'blinding', 'nonce'],
  };
}
