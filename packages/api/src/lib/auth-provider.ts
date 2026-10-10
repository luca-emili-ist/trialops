// Identity provider calls made by the server (IAM-01, CMP-03): password grant for the sign-in and the signature
// re-authentication, and the TOTP challenge + verify of Supabase Auth MFA. The server makes them so that failures are
// counted for the account lockout before the identity provider is ever asked (locked accounts are refused here).
// Tests and local development inject localAuth() instead (lib/local-auth.ts): no network.
import { HttpError } from '../errors.ts';

export interface AuthFactor { id: string; factor_type: string; status: 'verified' | 'unverified' | string; friendly_name?: string }
export interface AuthUser { id: string; email?: string; factors?: AuthFactor[] }
export interface AuthSession {
  access_token: string; refresh_token: string; token_type: string; expires_in: number; expires_at?: number; user: AuthUser;
}
/** invalid = the credentials were wrong (counts as a failure); otherwise the provider could not answer. */
export type GrantResult = { ok: true; session: AuthSession } | { ok: false; invalid: boolean; status: number };

export interface AuthProvider {
  passwordGrant(email: string, password: string): Promise<GrantResult>;
  /** The user behind an access token, with its MFA factors; null when the token is not accepted. */
  getUser(accessToken: string): Promise<AuthUser | null>;
  /** Challenge + verify of a TOTP factor with the user's access token; the new session (aal2), or null for a wrong code. */
  verifyTotp(accessToken: string, factorId: string, code: string): Promise<AuthSession | null>;
}

export const verifiedTotp = (u: AuthUser | null | undefined): AuthFactor[] =>
  (u?.factors ?? []).filter(f => f.factor_type === 'totp' && f.status === 'verified');

/** Supabase Auth (GoTrue) REST API with the project's publishable key. */
export function supabaseAuth(supabaseUrl: string, anonKey: string): AuthProvider {
  const base = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const call = async (path: string, init: { method?: string; token?: string; body?: unknown }) => {
    const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: {
      apikey: anonKey, 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, ok: res.ok, body };
  };
  const unavailable = (status: number) => status === 429
    ? new HttpError(429, 'rate_limited', 'Too many attempts at the identity provider; try again in a few minutes')
    : new HttpError(502, 'idp_unavailable', `The identity provider did not answer (${status})`);
  return {
    async passwordGrant(email, password) {
      const r = await call('/token?grant_type=password', { method: 'POST', body: { email, password } });
      if (r.ok) return { ok: true, session: r.body as unknown as AuthSession };
      // 400 invalid_credentials / email_not_confirmed: a failed attempt. Anything else: the provider failed.
      return { ok: false, invalid: r.status === 400 || r.status === 401 || r.status === 422, status: r.status };
    },
    async getUser(token) {
      const r = await call('/user', { token });
      if (r.status === 401 || r.status === 403) return null;
      if (!r.ok) throw unavailable(r.status);
      return r.body as unknown as AuthUser;
    },
    async verifyTotp(token, factorId, code) {
      const ch = await call(`/factors/${encodeURIComponent(factorId)}/challenge`, { method: 'POST', token, body: {} });
      if (!ch.ok) throw ch.status === 404 || ch.status === 422 ? new HttpError(404, 'not_found', 'no such authenticator') : unavailable(ch.status);
      const v = await call(`/factors/${encodeURIComponent(factorId)}/verify`, { method: 'POST', token,
        body: { challenge_id: (ch.body as { id?: string }).id, code } });
      if (v.ok) return v.body as unknown as AuthSession;
      if (v.status === 400 || v.status === 422) return null;   // invalid code
      throw unavailable(v.status);
    },
  };
}
