// Netlify Function hosting the Platform API. Bootstrap in netlify/lib/server.mts. Long AI work does not run here: it is
// queued as a job and handed to the background function ai-worker-background (0014), the client polls the job.
import { forward } from '../lib/server.mts';

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  return forward(`${url.pathname}${url.search}`, { method: req.method, headers: new Headers(req.headers),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer() });
};

export const config = { path: ['/v1/*', '/api/*', '/oidc/*', '/.well-known/*'] };
