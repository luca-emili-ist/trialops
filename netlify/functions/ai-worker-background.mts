// Netlify Background Function (name ends in -background: the caller gets 202 at once, the work may last up to 15 min).
// Runs one queued AI job (0014) through the same Platform API code, as the person who queued it: the bearer token is
// verified by the API and only the requester's own queued job can be claimed (RLS on core.ai_job). Idempotent.
import { forward } from '../lib/server.mts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async (req: Request): Promise<void> => {
  if (req.method !== 'POST') return;
  const jobId = ((await req.json().catch(() => ({}))) as { job_id?: string }).job_id ?? '';
  if (!UUID.test(jobId)) { console.error('ai-worker: invalid job id'); return; }
  const headers = new Headers({ 'content-type': 'application/json' });
  const auth = req.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  const res = await forward(`/v1/ai/jobs/${jobId}/execute`, { method: 'POST', headers });
  const job = (await res.json().catch(() => null)) as { status?: string; error?: string } | null;
  console.log(`ai-worker: job ${jobId} -> ${res.status} ${job?.status ?? ''} ${job?.error ?? ''}`.trim());
};
