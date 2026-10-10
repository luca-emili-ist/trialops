// Session: who is signed in and on which platform. Two modes:
// - supabase (deployed): email + password through the Platform API (POST /v1/auth/login: failed attempts counted, locked
//   accounts refused, CMP-03), then the authenticator code (TOTP, Supabase Auth MFA) or its enrolment (IAM-01); the
//   tokens are installed in Supabase Auth with setSession and enriched by core.custom_access_token_hook;
// - dev (local): demo user switch served by the local API (DEMO-02), only when TRIALOPS_DEV_LOGIN=1 on the API.
// Idle timeout (CMP-03): the session ends after the inactivity limit of the API (GET /v1/me), with a warning 60 s before;
// the server enforces the same limit and answers 401 session_idle, which also ends the session here.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Button, Modal, SignMfaContext } from '@trialops/shell';
import { api, get, setSessionEndHandler, setToken } from './api.ts';
import { go } from './router.ts';

export interface MfaStatus { required: boolean; satisfied: boolean; exempt: boolean; enrolled: boolean; aal: string | null }
export interface Me {
  sub: string; email: string | null; org_id: string | null; roles: string[]; platform_ids: string[]; blinding: string;
  person: { id: string; full_name: string; email: string } | null;
  mfa: MfaStatus; session: { idle_timeout_minutes: number };
}
export interface Platform { id: string; code: string; title: string; therapeutic_area: string; lead_operator: string }

/** The step of the sign-in after the password: the code of the authenticator, or the enrolment of a first one. */
export type MfaStep = { kind: 'challenge'; factorId: string } | { kind: 'enrol'; factorId: string; qr: string; secret: string };

interface Tokens { access_token: string; refresh_token: string }

interface Session {
  mode: 'supabase' | 'dev';
  me: Me | null; platform: Platform | null; loading: boolean;
  /** Set while the sign-in waits for the authenticator (the app is not loaded yet). */
  mfaStep: MfaStep | null;
  /** Why the last session ended (idle timeout, lock), shown on the sign-in page. */
  notice: string | null;
  signIn(emailOrSub: string, password?: string): Promise<void>;
  verifyMfa(code: string): Promise<void>;
  signOut(): Promise<void>;
  can(...roles: string[]): boolean;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
const DEV_KEY = 'trialops.dev.token';
const ACTIVITY_KEY = 'trialops.activity';   // last activity shared by the tabs of the browser
const store = {
  get: () => { try { return sessionStorage.getItem(DEV_KEY); } catch { return null; } },
  set: (v: string | null) => { try { if (v) sessionStorage.setItem(DEV_KEY, v); else sessionStorage.removeItem(DEV_KEY); } catch { /* storage blocked */ } },
};
const activity = {
  get: () => { try { return Number(localStorage.getItem(ACTIVITY_KEY)) || 0; } catch { return 0; } },
  set: (t: number) => { try { localStorage.setItem(ACTIVITY_KEY, String(t)); } catch { /* storage blocked */ } },
};

/** The next MFA step of a password session: challenge of the verified authenticator, or enrolment of a new one. */
async function nextMfaStep(): Promise<MfaStep> {
  if (!supabase) throw new Error('Multi-factor authentication is required but no authenticator service is configured');
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  const verified = data.totp[0];
  if (verified) return { kind: 'challenge', factorId: verified.id };
  // an enrolment left half-way leaves an unverified factor: remove it and start again
  for (const f of data.all.filter(f => f.factor_type === 'totp' && f.status === 'unverified')) await supabase.auth.mfa.unenroll({ factorId: f.id });
  const en = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: 'TrialOps', friendlyName: `TrialOps ${new Date().toISOString().slice(0, 19)}` });
  if (en.error) throw en.error;
  return { kind: 'enrol', factorId: en.data.id, qr: en.data.totp.qr_code, secret: en.data.totp.secret };
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [loading, setLoading] = useState(true);
  const [mfaStep, setMfaStep] = useState<MfaStep | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState(false);

  /** Loads the identity behind a token; returns the error message when the API refuses or is unreachable. */
  const load = useCallback(async (token: string | null): Promise<string | null> => {
    setToken(token);
    if (!token) { setMe(null); setPlatform(null); setMfaStep(null); setLoading(false); return null; }
    try {
      const m = await get<Me>('/v1/me');
      if (m.mfa?.required && !m.mfa.satisfied && !m.mfa.exempt) {
        const step = await nextMfaStep();
        setMe(null); setPlatform(null); setMfaStep(step); setLoading(false);
        return null;
      }
      const ps = await get<{ items: Platform[] }>('/v1/platforms');
      setMfaStep(null); setMe(m); setPlatform(ps.items[0] ?? null); setLoading(false);
      return null;
    } catch (e) {
      setToken(null); store.set(null); setMe(null); setPlatform(null); setMfaStep(null); setLoading(false);
      return `Signed in, but TrialOps could not load your profile: ${(e as Error).message}`;
    }
  }, []);

  /** Ends the session in this browser (the server has already ended it, or is told separately) and explains why. */
  const endLocally = useCallback(async (why: string | null) => {
    setWarning(false);
    if (supabase) await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    store.set(null);
    setNotice(why);
    await load(null);
    go('/login');
  }, [load]);

  useEffect(() => {
    setSessionEndHandler(e => { void endLocally(e.message); });
    return () => setSessionEndHandler(null);
  }, [endLocally]);

  useEffect(() => {
    if (supabase) {
      void supabase.auth.getSession().then(({ data }) => load(data.session?.access_token ?? null));
      const { data } = supabase.auth.onAuthStateChange((_e, s) => { setToken(s?.access_token ?? null); });
      return () => data.subscription.unsubscribe();
    }
    void load(store.get());
    return undefined;
  }, [load]);

  // CMP-03 idle timer: warning 60 s before the limit, sign-out at the limit. Activity keeps the server session alive
  // (GET /v1/me at most once a minute), so the server and the browser count the same inactivity.
  const lastPing = useRef(0);
  useEffect(() => {
    if (!me) return undefined;
    const minutes = me.session?.idle_timeout_minutes ?? 15;
    const limit = minutes * 60_000;
    let mine = Date.now();
    activity.set(mine);
    lastPing.current = mine;
    let lastShared = mine;
    const onActivity = () => {
      const now = Date.now();
      mine = now;
      if (now - lastShared > 5_000) { lastShared = now; activity.set(now); }
      if (now - lastPing.current > 60_000) { lastPing.current = now; void get('/v1/me').catch(() => undefined); }
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true });
    const timer = window.setInterval(() => {
      const idle = Date.now() - Math.max(mine, activity.get());
      if (idle >= limit) {
        window.clearInterval(timer);
        void api('POST', '/v1/auth/session/end', { body: { reason: 'idle_timeout' } }).catch(() => undefined)
          .then(() => endLocally(`Your session ended after ${minutes} minutes of inactivity. Sign in again to continue.`));
      } else setWarning(idle >= limit - 60_000);
    }, 1_000);
    return () => { window.clearInterval(timer); for (const ev of events) window.removeEventListener(ev, onActivity); setWarning(false); };
  }, [me, endLocally]);

  const install = async (t: Tokens) => {
    if (supabase) {
      const { error } = await supabase.auth.setSession({ access_token: t.access_token, refresh_token: t.refresh_token });
      if (error) throw new Error(error.message);
    }
    const problem = await load(t.access_token);
    if (problem) { if (supabase) await supabase.auth.signOut({ scope: 'local' }); throw new Error(problem); }
  };

  const value: Session = {
    mode: supabase ? 'supabase' : 'dev', me, platform, loading, mfaStep, notice,
    async signIn(emailOrSub, password) {
      setNotice(null);
      setToken(null);
      if (supabase) {
        const t = await api<Tokens>('POST', '/v1/auth/login', { body: { email: emailOrSub, password: password ?? '' } });
        setLoading(true);
        try { await install(t); } finally { setLoading(false); }
      } else {
        setLoading(true);
        const r = await api<{ access_token: string }>('POST', '/v1/dev/login', { body: { sub: emailOrSub } });
        store.set(r.access_token);
        const problem = await load(r.access_token);
        if (problem) throw new Error(problem);
      }
    },
    async verifyMfa(code) {
      if (!mfaStep) throw new Error('No authenticator step in progress');
      const t = await api<Tokens>('POST', '/v1/auth/mfa/verify', { body: { factor_id: mfaStep.factorId, code } });
      await install(t);
    },
    async signOut() {
      await api('POST', '/v1/auth/session/end', { body: { reason: 'logout' } }).catch(() => undefined);
      if (supabase) await supabase.auth.signOut();
      store.set(null); setNotice(null); await load(null);
    },
    can: (...roles) => roles.some(r => me?.roles.includes(r)),
  };
  return (
    <Ctx.Provider value={value}>
      <SignMfaContext.Provider value={!!me?.mfa?.enrolled}>{children}</SignMfaContext.Provider>
      {warning && me ? <Modal title="Your session is about to end" onClose={() => setWarning(false)} actions={<>
        <Button onClick={() => { void value.signOut().then(() => go('/login')); }}>Sign out</Button>
        <Button variant="primary" onClick={() => setWarning(false)}>Stay signed in</Button>
      </>}>
        <p>For your security you will be signed out in less than a minute because of inactivity
          ({me.session?.idle_timeout_minutes ?? 15} minutes). Unsaved changes will be lost.</p>
      </Modal> : null}
    </Ctx.Provider>
  );
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** Loads a GET resource and exposes reload; errors are shown by the page. */
export function useData<T>(path: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState(s => ({ ...s, loading: true }));
    get<T>(path).then(d => live && setState({ data: d, error: null, loading: false }),
      e => live && setState({ data: null, error: (e as Error).message, loading: false }));
    return () => { live = false; };
  }, [path, n]);
  return { ...state, reload: () => setN(x => x + 1) };
}
