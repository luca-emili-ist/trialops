// Access policy of the Platform API (IAM-01, CMP-03): one check for every authenticated request, right after the token
// is verified and before the route runs.
//   1. account lockout: a locked subject/email is refused (423 account_locked), whatever the token;
//   2. session idle timeout: per Supabase session (claim session_id), refused once idle for longer than the limit
//      (401 session_idle); the session then stays ended;
//   3. MFA: a person with at least one role must hold an aal2 token (403 mfa_required), except on the routes that
//      serve the sign-in itself (GET /v1/me, the MFA verification, sign-out).
// The bookkeeping runs in the database (0018) as the role auth_service, in its own transaction, so a refusal is recorded
// even though the request itself does not run.
import type pg from 'pg';
import type { Claims } from '../auth.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { AuthMethod, Credential, ReauthOptions, Reauthenticator } from './reauth.ts';

export interface AccessConfig {
  /** 'required' (default): MFA for every person with a role. 'off': no MFA check (never in a GxP production environment). */
  mfa: 'required' | 'off';
  /** Demo deviation only: email domains whose accounts may work at aal1 (synthetic demo accounts). */
  mfaExemptDomains: string[];
  lockout: { max: number; windowMinutes: number; lockMinutes: number };
  idleMinutes: number;
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };

export function accessConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  return {
    mfa: env.TRIALOPS_MFA === 'off' ? 'off' : 'required',
    mfaExemptDomains: (env.TRIALOPS_MFA_EXEMPT_EMAIL_DOMAINS ?? '').split(',').map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
    lockout: { max: num(env.TRIALOPS_LOCKOUT_MAX, 5), windowMinutes: num(env.TRIALOPS_LOCKOUT_WINDOW_MIN, 15), lockMinutes: num(env.TRIALOPS_LOCKOUT_MINUTES, 30) },
    idleMinutes: num(env.TRIALOPS_IDLE_MINUTES, 15),
  };
}

export interface MfaStatus { required: boolean; satisfied: boolean; exempt: boolean; enrolled: boolean; aal: string | null }

/** MFA position of a token. enrolled: the token proves a second factor (aal2), so signing will ask for its code. */
export function mfaStatus(claims: Claims, cfg: AccessConfig): MfaStatus {
  const aal = typeof claims.aal === 'string' ? claims.aal : null;
  const satisfied = aal === 'aal2';
  const isPerson = (claims.actor_type ?? 'user') === 'user';
  const required = cfg.mfa === 'required' && isPerson && (claims.roles ?? []).length > 0;
  const domain = (claims.email ?? '').toLowerCase().split('@')[1] ?? '';
  const exempt = required && !!domain && cfg.mfaExemptDomains.includes(domain);
  return { required, satisfied, exempt, enrolled: satisfied, aal };
}

/** Claims under which the API records sign-in events that have no verified caller yet (the sign-in route). */
export const SYSTEM_AUTH: Claims = { sub: 'system:auth', actor_type: 'system' as Claims['actor_type'] };

/** Runs fn in its own transaction as the role auth_service, with the given (verified) claims as the actor of the audit rows. */
export async function authTx<T>(pool: pg.Pool, claims: Claims, fn: (db: Db) => Promise<T>, reason?: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    if (reason) await client.query("select set_config('trialops.change_reason', $1, true)", [reason]);
    await client.query('set local role auth_service');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export const sessionIdOf = (claims: Claims): string | null => typeof claims.session_id === 'string' && claims.session_id ? claims.session_id : null;

export function lockedError(until?: Date | string | null): HttpError {
  const when = until ? ` until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  return new HttpError(423, 'account_locked', `This account is locked${when} after repeated failed sign-in or signature attempts. ` +
    'Ask a platform administrator to unlock it.');
}

/** The access policy of one request (see the header). `allowBelowMfa`: routes that serve the sign-in itself. */
export async function enforceAccessPolicy(pool: pg.Pool, claims: Claims, cfg: AccessConfig, allowBelowMfa: boolean): Promise<void> {
  const verdict = (await authTx(pool, claims, db => db.query('select core.access_check($1, $2, $3, $4) v',
    [claims.sub, claims.email ?? null, sessionIdOf(claims), cfg.idleMinutes]))).rows[0].v as string;
  if (verdict === 'account_locked') throw lockedError();
  if (verdict === 'session_idle') {
    throw new HttpError(401, 'session_idle', `Your session ended after ${cfg.idleMinutes} minutes of inactivity. Sign in again.`);
  }
  if (verdict === 'session_ended') throw new HttpError(401, 'session_ended', 'This session has ended. Sign in again.');
  const m = mfaStatus(claims, cfg);
  if (!allowBelowMfa && m.required && !m.satisfied && !m.exempt) {
    throw new HttpError(403, 'mfa_required', 'Multi-factor authentication is required: verify the code of your authenticator app');
  }
}

/** Records a failed attempt of an identity; returns the lock end when the identity is (now) locked. */
export type AuthRunner = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
export async function recordFailure(run: AuthRunner, cfg: AccessConfig, f: {
  event: 'login_failed' | 'signature_reauth_failed'; email?: string | null; sub?: string | null; ip?: string | null; detail?: Record<string, unknown>;
}): Promise<string | null> {
  const r = await run(db => db.query('select core.auth_failure($1, $2, $3, $4, $5, $6, $7, $8) u',
    [f.event, f.email ?? null, f.sub ?? null, f.ip ?? null, JSON.stringify(f.detail ?? {}), cfg.lockout.max, cfg.lockout.windowMinutes, cfg.lockout.lockMinutes]));
  return r.rows[0].u ?? null;
}

/** An error with work to do once the request transaction is over; it may replace the error (e.g. 423 when now locked). */
export interface Deferred { afterRollback?: () => Promise<HttpError | undefined> }

/** Wraps the re-authentication of signatures with the policy: MFA requirement, and failed attempts counted for the lockout. */
export function policyReauth(inner: Reauthenticator, pool: pg.Pool, cfg: AccessConfig): Reauthenticator {
  return {
    async reauth(claims: Claims, credential: Credential, options?: ReauthOptions): Promise<AuthMethod> {
      const m = mfaStatus(claims, cfg);
      try {
        return await inner.reauth(claims, credential, { mfaRequired: m.required && !m.exempt, ...options });
      } catch (e) {
        // only a wrong password or code counts; a missing one is a form error
        // Recorded after the request transaction has rolled back (app.ts): that transaction may hold the audit chain lock,
        // so writing the failure from a second connection now would wait for it forever.
        if (e instanceof HttpError && e.code === 'reauth_failed' && credential.password) {
          (e as Deferred).afterRollback = async () => {
            const until = await recordFailure(fn => authTx(pool, claims, fn), cfg, { event: 'signature_reauth_failed', email: claims.email, sub: claims.sub });
            return until ? lockedError(until) : undefined;
          };
        }
        throw e;
      }
    },
  };
}

/** Client address for the sign-in events (Netlify header first). Optional, informational. */
export function clientIp(headers: Record<string, string | undefined>): string | null {
  const h = headers['x-nf-client-connection-ip'] ?? headers['x-forwarded-for']?.split(',')[0];
  return h?.trim().slice(0, 64) || null;
}
