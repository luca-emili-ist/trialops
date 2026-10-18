// Platform API client. The bearer token comes from the session (Supabase Auth, or the demo user switch in development).
let token: string | null = null;
export const setToken = (t: string | null) => { token = t; };

export class ApiError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

/** Called when the API ends the session (CMP-03): idle timeout, signed out elsewhere, or account locked. */
const SESSION_END_CODES = ['session_idle', 'session_ended', 'account_locked'];
let onSessionEnd: ((e: ApiError) => void) | null = null;
export const setSessionEndHandler = (fn: ((e: ApiError) => void) | null) => { onSessionEnd = fn; };

/** UUID v4 for the Idempotency-Key (crypto.randomUUID needs a secure context: HTTPS or localhost). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function api<T = any>(method: string, path: string, opts: { body?: unknown; reason?: string } = {}): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.reason) headers['x-change-reason'] = opts.reason;
  // APP-DT-02: every write carries a fresh Idempotency-Key, so a retried request cannot be applied twice
  if (method.toUpperCase() !== 'GET') headers['idempotency-key'] = newIdempotencyKey();
  const res = await fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`);
    if (token && SESSION_END_CODES.includes(e.code)) onSessionEnd?.(e);
    throw e;
  }
  return data as T;
}
export const get = <T = any>(path: string) => api<T>('GET', path); // eslint-disable-line @typescript-eslint/no-explicit-any

/** AI job (0014): AI tasks and agent runs are queued and run by a worker; the client polls until the job ends. */
export interface AiJob<R = any> { id: string; kind: string; status: 'queued' | 'running' | 'completed' | 'failed'; result: R | null; error: string | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  ai_request_id: string | null; deadline_at: string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Starts a job (POST answering 202) and waits for its end; failed jobs reject with the recorded reason. */
export async function runJob<R = any>(method: string, path: string, opts: { body?: unknown; onStatus?: (s: AiJob['status']) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  intervalMs?: number } = {}): Promise<R> {
  let job = await api<AiJob<R>>(method, path, { body: opts.body });
  const limit = Date.parse(job.deadline_at) + 17 * 60_000;   // the server closes stuck jobs; this only guards the loop
  let last: AiJob['status'] | null = null;
  while (job.status === 'queued' || job.status === 'running') {
    if (job.status !== last) { last = job.status; opts.onStatus?.(job.status); }
    if (Date.now() > limit) throw new Error('The AI job did not finish in time');
    await sleep(opts.intervalMs ?? 1500);
    job = await get<AiJob<R>>(`/v1/ai/jobs/${job.id}`);
  }
  if (job.status === 'failed') throw new Error(job.error ?? 'The AI job failed');
  return job.result as R;
}

/** Downloads a file produced by the API (e.g. the CSV export of the audit trail) with the bearer token of the session. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Download failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
