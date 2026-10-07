// Platform API client. The bearer token comes from the session (Supabase Auth, or the demo user switch in development).
let token: string | null = null;
export const setToken = (t: string | null) => { token = t; };

export class ApiError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export async function api<T = any>(method: string, path: string, opts: { body?: unknown; reason?: string } = {}): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.reason) headers['x-change-reason'] = opts.reason;
  const res = await fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}
export const get = <T = any>(path: string) => api<T>('GET', path); // eslint-disable-line @typescript-eslint/no-explicit-any
