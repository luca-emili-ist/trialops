// Part 11 signature service for the UI and for apps (APP-ID-06, CMP-02): the signer re-authenticates in TrialOps.
import { route, uuid } from '../route.ts';
import { sign, SIGNABLE_TABLES, type Meaning } from '../lib/sign.ts';

export const signatureRoutes = [
  route<{ target_table: string; target_id: string; meaning: Meaning; password?: string }>({
    method: 'post', path: '/v1/signatures', status: 201, summary: 'Sign a record (re-authentication required)', tag: 'signatures',
    reqs: ['CMP-02'],
    body: { type: 'object', required: ['target_table', 'target_id', 'meaning'], additionalProperties: false,
      properties: { target_table: { enum: SIGNABLE_TABLES }, target_id: uuid,
        meaning: { enum: ['author', 'review', 'approval', 'verification', 'responsibility'] }, password: { type: 'string' } } },
    handler: async ({ db, claims, body, services }) => sign(db, claims, services.reauth, {
      target_table: body.target_table, target_id: body.target_id, meaning: body.meaning, credential: { password: body.password },
      requested_by_app: claims.actor_type === 'app' ? claims.app_id : undefined,
    }),
  }),
  route({ method: 'get', path: '/v1/signatures', summary: 'Signatures on a record', tag: 'signatures', reqs: ['CMP-02'],
    query: { target_id: uuid },
    handler: async ({ db, query }) => ({
      items: (await db.query(`select id, signer_sub, signer_name, meaning, target_table, target_id, target_hash, auth_method, signed_at
        from core.signature where target_id = $1 order by signed_at`, [query.target_id ?? null])).rows,
    }) }),
];
