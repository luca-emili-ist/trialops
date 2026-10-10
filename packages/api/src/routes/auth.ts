// Sign-in, MFA step-up, sign-out and account unlock (IAM-01, CMP-03; 21 CFR 11.10(d), 11.300, Annex 11 §12).
// The web app signs in through the API, not directly at Supabase Auth, so that failed attempts are counted and a locked
// account is refused before the identity provider is asked. Passwords and codes are passed through, never stored.
import { decodeJwt } from 'jose';
import { route } from '../route.ts';
import { bearer } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { clientIp, lockedError, recordFailure, sessionIdOf } from '../lib/access-policy.ts';
import type { AuthSession } from '../lib/auth-provider.ts';

const reqs = ['CMP-03', 'IAM-01'];

/** What the web app needs to install the session (supabase.auth.setSession); the user's factors stay at the provider. */
const sessionOut = (s: AuthSession) => ({ access_token: s.access_token, refresh_token: s.refresh_token, token_type: s.token_type,
  expires_in: s.expires_in, expires_at: s.expires_at ?? null, user: { id: s.user.id, email: s.user.email ?? null } });

const claimsOf = (token: string): Record<string, unknown> => { try { return decodeJwt(token); } catch { return {}; } };

export const authRoutes = [
  route<{ email: string; password: string }>({ method: 'post', path: '/v1/auth/login', public: true, manualTx: true, tag: 'auth', reqs,
    summary: 'Sign in with email and password (Supabase Auth password grant made by the server); locked accounts are refused (423)',
    body: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: {
      email: { type: 'string', minLength: 3, maxLength: 320 }, password: { type: 'string', minLength: 1, maxLength: 1024 } } },
    handler: async ({ body, services, access, authTx, headers }) => {
      const email = body.email.trim().toLowerCase();
      const ip = clientIp(headers);
      const lockedUntil = await authTx(async db => (await db.query('select core.auth_login_check($1, $2) u', [email, ip])).rows[0].u);
      if (lockedUntil) throw lockedError(lockedUntil);
      if (!services.auth) throw new HttpError(501, 'login_unavailable', 'no identity provider configured');
      const g = await services.auth.passwordGrant(email, body.password);
      if (!g.ok) {
        if (!g.invalid) throw new HttpError(g.status === 429 ? 429 : 502, g.status === 429 ? 'rate_limited' : 'idp_unavailable',
          'The identity provider could not check the credentials; try again later');
        const until = await authTx(async db => (await db.query('select core.auth_failure($1, $2, null, $3, $4, $5, $6, $7) u',
          ['login_failed', email, ip, JSON.stringify({ step: 'password' }), access.lockout.max, access.lockout.windowMinutes, access.lockout.lockMinutes])).rows[0].u);
        if (until) throw lockedError(until);
        throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
      }
      const c = claimsOf(g.session.access_token);
      await authTx(db => db.query('select core.auth_login_succeeded($1, $2, $3, $4, $5)',
        [email, g.session.user.id, typeof c.session_id === 'string' ? c.session_id : null, ip, typeof c.aal === 'string' ? c.aal : null]));
      return sessionOut(g.session);
    } }),

  route<{ factor_id: string; code: string }>({ method: 'post', path: '/v1/auth/mfa/verify', manualTx: true, allowBelowMfa: true, tag: 'auth', reqs,
    summary: 'Verify the code of an authenticator (TOTP): completes the sign-in (aal2) or the enrolment of a new authenticator',
    body: { type: 'object', additionalProperties: false, required: ['factor_id', 'code'], properties: {
      factor_id: { type: 'string', minLength: 1, maxLength: 64 }, code: { type: 'string', pattern: '^[0-9]{6}$' } } },
    handler: async ({ body, claims, services, access, authTx, headers }) => {
      requirePerson(claims, 'Verifying an authenticator');
      if (!services.auth) throw new HttpError(501, 'login_unavailable', 'no identity provider configured');
      const token = bearer(headers.authorization);
      const user = await services.auth.getUser(token);
      if (!user || user.id !== claims.sub) throw new HttpError(401, 'invalid_token', 'the identity provider does not accept this token');
      const factor = (user.factors ?? []).find(f => f.id === body.factor_id && f.factor_type === 'totp');
      if (!factor) throw new HttpError(404, 'not_found', 'no such authenticator');
      const s = await services.auth.verifyTotp(token, factor.id, body.code);
      if (!s) {
        const until = await recordFailure(authTx, access, { event: 'login_failed', email: claims.email, sub: claims.sub,
          ip: clientIp(headers), detail: { step: factor.status === 'verified' ? 'totp' : 'totp_enrolment' } });
        if (until) throw lockedError(until);
        throw new HttpError(401, 'mfa_failed', 'The code is not valid. Check the time of your device and try again.');
      }
      if (factor.status !== 'verified') {
        await authTx(db => db.query('select core.auth_mfa_enrolled($1, $2, $3, $4)', [claims.email ?? null, claims.sub, sessionIdOf(claims), factor.id]));
      }
      return sessionOut(s);
    } }),

  route<{ reason: 'logout' | 'idle_timeout' }>({ method: 'post', path: '/v1/auth/session/end', manualTx: true, allowBelowMfa: true, tag: 'auth', reqs: ['CMP-03'],
    summary: 'End the current session: sign-out, or the idle timer of the client expired (recorded in the audit trail)',
    body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { enum: ['logout', 'idle_timeout'] } } },
    handler: async ({ body, claims, access, authTx }) => {
      const sid = sessionIdOf(claims);
      if (!sid) return { ended: false };
      const ended = (await authTx(db => db.query('select core.auth_session_end($1, $2, $3, $4, $5) e',
        [claims.sub, claims.email ?? null, sid, body.reason, access.idleMinutes]))).rows[0].e as boolean;
      return { ended };
    } }),

  route({ method: 'get', path: '/v1/admin/accounts/locks', tag: 'auth', reqs: ['CMP-03'], summary: 'Open account locks (platform admin)',
    handler: async ({ db, claims }) => {
      requirePerson(claims, 'Reading account locks'); requireRole(claims, ['platform_admin'], 'Reading account locks');
      return { items: (await db.query('select * from core.account_locks_open()')).rows };
    } }),

  route<{ email?: string; sub?: string }>({ method: 'post', path: '/v1/admin/accounts/unlock', needsReason: true, tag: 'auth', reqs: ['CMP-03'],
    summary: 'Unlock an account (platform admin, change reason required; audited)',
    body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      email: { type: 'string', minLength: 3, maxLength: 320 }, sub: { type: 'string', minLength: 1, maxLength: 255 } } },
    handler: async ({ db, claims, body }) => {
      requirePerson(claims, 'Unlocking an account'); requireRole(claims, ['platform_admin'], 'Unlocking an account');
      const n = (await db.query('select core.account_unlock($1, $2) n', [body.email ?? null, body.sub ?? null])).rows[0].n as number;
      if (!n) throw new HttpError(404, 'not_locked', 'this account has no open lock');
      return { unlocked: n };
    } }),
];
