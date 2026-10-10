// Local identity provider for tests and local development only (scripts/dev.mjs, packages/api/test): synthetic users, one
// shared test password and one fixed test TOTP code, tokens minted by the caller with its local test key. Never wired in a
// deployed environment (netlify/lib/server.mts uses supabaseAuth).
import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import type { AuthFactor, AuthProvider, AuthSession } from './auth-provider.ts';

export interface LocalAuthOptions {
  /** Subject of a synthetic user by email; null = unknown. */
  lookup(email: string): Promise<string | null>;
  /** Signs an access token for a subject with extra claims (aal, amr, session_id). */
  mint(sub: string, extra: Record<string, unknown>): Promise<string>;
  password: string;
  totp: string;
  /** TOTP factors of a subject; default: one verified factor. */
  factorsFor?(sub: string): AuthFactor[];
  /** Called on every request to this provider (tests: "no identity provider call while locked"). */
  onCall?(op: 'passwordGrant' | 'getUser' | 'verifyTotp'): void;
}

export function localAuth(o: LocalAuthOptions): AuthProvider & { calls: number } {
  const factorsFor = o.factorsFor ?? ((sub: string) => [{ id: `totp-${sub}`, factor_type: 'totp', status: 'verified' }]);
  const self = {
    calls: 0,
    async passwordGrant(email: string, password: string) {
      self.calls++; o.onCall?.('passwordGrant');
      const sub = await o.lookup(email.toLowerCase());
      if (!sub || password !== o.password) return { ok: false as const, invalid: true, status: 400 };
      return { ok: true as const, session: await session(sub, email, 'aal1', randomUUID()) };
    },
    async getUser(token: string) {
      self.calls++; o.onCall?.('getUser');
      const sub = decodeJwt(token).sub;
      return sub ? { id: sub, factors: factorsFor(sub) } : null;
    },
    async verifyTotp(token: string, factorId: string, code: string) {
      self.calls++; o.onCall?.('verifyTotp');
      const p = decodeJwt(token);
      if (!p.sub || !factorsFor(p.sub).some(f => f.id === factorId) || code !== o.totp) return null;
      return session(p.sub, String(p.email ?? ''), 'aal2', String(p.session_id ?? randomUUID()));
    },
  };
  async function session(sub: string, email: string, aal: 'aal1' | 'aal2', sessionId: string): Promise<AuthSession> {
    const amr = [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }, ...(aal === 'aal2' ? [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] : [])];
    return { access_token: await o.mint(sub, { aal, amr, session_id: sessionId }), refresh_token: randomUUID(), token_type: 'bearer',
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: sub, email, factors: factorsFor(sub) } };
  }
  return self;
}
