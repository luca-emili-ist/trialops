// Session: who is signed in and on which platform. Two modes:
// - supabase (deployed): Supabase Auth email + password, token enriched by core.custom_access_token_hook;
// - dev (local): demo user switch served by the local API (DEMO-02), only when TRIALOPS_DEV_LOGIN=1 on the API.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { api, get, setToken } from './api.ts';

export interface Me {
  sub: string; email: string | null; org_id: string | null; roles: string[]; platform_ids: string[]; blinding: string;
  person: { id: string; full_name: string; email: string } | null;
}
export interface Platform { id: string; code: string; title: string; therapeutic_area: string; lead_operator: string }

interface Session {
  mode: 'supabase' | 'dev';
  me: Me | null; platform: Platform | null; loading: boolean;
  signIn(emailOrSub: string, password?: string): Promise<void>;
  signOut(): Promise<void>;
  can(...roles: string[]): boolean;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
const DEV_KEY = 'trialops.dev.token';
const store = {
  get: () => { try { return sessionStorage.getItem(DEV_KEY); } catch { return null; } },
  set: (v: string | null) => { try { if (v) sessionStorage.setItem(DEV_KEY, v); else sessionStorage.removeItem(DEV_KEY); } catch { /* storage blocked */ } },
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (token: string | null) => {
    setToken(token);
    if (!token) { setMe(null); setPlatform(null); setLoading(false); return; }
    try {
      const m = await get<Me>('/v1/me');
      const ps = await get<{ items: Platform[] }>('/v1/platforms');
      setMe(m); setPlatform(ps.items[0] ?? null);
    } catch { setToken(null); store.set(null); setMe(null); setPlatform(null); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (supabase) {
      void supabase.auth.getSession().then(({ data }) => load(data.session?.access_token ?? null));
      const { data } = supabase.auth.onAuthStateChange((_e, s) => { setToken(s?.access_token ?? null); });
      return () => data.subscription.unsubscribe();
    }
    void load(store.get());
    return undefined;
  }, [load]);

  const value: Session = {
    mode: supabase ? 'supabase' : 'dev', me, platform, loading,
    async signIn(emailOrSub, password) {
      setLoading(true);
      if (supabase) {
        const { data, error } = await supabase.auth.signInWithPassword({ email: emailOrSub, password: password ?? '' });
        if (error) { setLoading(false); throw new Error(error.message); }
        await load(data.session?.access_token ?? null);
      } else {
        const r = await api<{ access_token: string }>('POST', '/v1/dev/login', { body: { sub: emailOrSub } });
        store.set(r.access_token);
        await load(r.access_token);
      }
    },
    async signOut() { if (supabase) await supabase.auth.signOut(); store.set(null); await load(null); },
    can: (...roles) => roles.some(r => me?.roles.includes(r)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
