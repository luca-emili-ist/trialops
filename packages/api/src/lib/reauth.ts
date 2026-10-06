// Re-authentication for Part 11 signatures (APP-ID-06, CMP-02): the signer proves identity again at signing time.
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';

export type AuthMethod = 'reauth_password' | 'reauth_mfa' | 'sso_step_up';
export interface Credential { password?: string }
export interface Reauthenticator {
  reauth(claims: Claims, credential: Credential): Promise<AuthMethod>;
}

/** Supabase Auth: password grant for the signer's email; the returned user must be the token subject. */
export function supabaseReauth(supabaseUrl: string, anonKey: string): Reauthenticator {
  return {
    async reauth(claims, { password }) {
      if (!password || !claims.email) throw new HttpError(401, 'reauth_failed', 'password re-entry required to sign');
      const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ email: claims.email, password }),
      });
      const body = await res.json().catch(() => ({})) as { user?: { id?: string } };
      if (!res.ok || body.user?.id !== claims.sub) throw new HttpError(401, 'reauth_failed', 'signature re-authentication failed');
      return 'reauth_password';
    },
  };
}
