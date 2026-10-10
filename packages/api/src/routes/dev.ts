// Demo user switch for local development (DEMO-02). Off unless the server is started with a devLogin service, which
// scripts/dev.mjs does only with TRIALOPS_DEV_LOGIN=1; deployed environments sign in through Supabase Auth. The token stands
// for a completed sign-in with MFA (aal2) and carries its own session_id, so the access policy (IAM-01, CMP-03) applies.
import { route } from '../route.ts';
import { HttpError } from '../errors.ts';

export const devRoutes = [
  route({ method: 'get', path: '/v1/dev/users', public: true, tag: 'dev', reqs: [], summary: 'Demo users (local development only)',
    handler: async ({ services }) => {
      if (!services.devLogin || !services.devUsers) throw new HttpError(404, 'not_found', 'no such route');
      return { items: await services.devUsers() };
    } }),
  route<{ sub: string }>({ method: 'post', path: '/v1/dev/login', public: true, tag: 'dev', reqs: [], summary: 'Token for a demo user (local development only)',
    body: { type: 'object', additionalProperties: false, required: ['sub'], properties: { sub: { type: 'string', pattern: '^demo\\|' } } },
    handler: async ({ body, services }) => {
      if (!services.devLogin) throw new HttpError(404, 'not_found', 'no such route');
      return { access_token: await services.devLogin(body.sub) };
    } }),
];
