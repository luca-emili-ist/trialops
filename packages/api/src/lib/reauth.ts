// Re-authentication for Part 11 signatures (APP-ID-06, CMP-02, IAM-01): the signer proves identity again at signing time,
// with the password and, when the signer has an authenticator (TOTP factor), its one-time code (MFA step-up).
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { supabaseAuth, verifiedTotp, type AuthProvider } from './auth-provider.ts';

export type AuthMethod = 'reauth_password' | 'reauth_mfa' | 'sso_step_up';
export interface Credential { password?: string; totp?: string }
export interface ReauthOptions {
  /** MFA is mandatory for this signer (TRIALOPS_MFA=required and not an exempt demo account): no factor, no signature. */
  mfaRequired?: boolean;
}
export interface Reauthenticator {
  reauth(claims: Claims, credential: Credential, options?: ReauthOptions): Promise<AuthMethod>;
}

/** Password grant for the signer's email (the returned user must be the token subject), then the TOTP code when the
 * signer has a verified factor: 'reauth_mfa'. Without a factor: 'reauth_password', or refused when MFA is mandatory. */
export function providerReauth(auth: AuthProvider): Reauthenticator {
  return {
    async reauth(claims, { password, totp }, { mfaRequired = false } = {}) {
      if (!password || !claims.email) throw new HttpError(401, 'reauth_failed', 'password re-entry required to sign');
      const g = await auth.passwordGrant(claims.email, password);
      if (!g.ok && !g.invalid) throw new HttpError(502, 'idp_unavailable', `The identity provider did not answer (${g.status})`);
      if (!g.ok || g.session.user.id !== claims.sub) throw new HttpError(401, 'reauth_failed', 'signature re-authentication failed');
      const factors = verifiedTotp(g.session.user);
      if (factors.length) {
        if (!totp?.trim()) throw new HttpError(401, 'mfa_code_required', 'Enter the code of your authenticator app to sign');
        for (const f of factors) if (await auth.verifyTotp(g.session.access_token, f.id, totp.trim())) return 'reauth_mfa';
        throw new HttpError(401, 'reauth_failed', 'signature re-authentication failed: the authenticator code is not valid');
      }
      if (mfaRequired) throw new HttpError(403, 'mfa_required', 'Signing requires multi-factor authentication: set up an authenticator app first');
      return 'reauth_password';
    },
  };
}

/** Supabase Auth: password grant + MFA challenge/verify with the access token of that grant. */
export function supabaseReauth(supabaseUrl: string, anonKey: string): Reauthenticator {
  return providerReauth(supabaseAuth(supabaseUrl, anonKey));
}
