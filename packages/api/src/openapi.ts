// OpenAPI 3.1 document generated from the route registry.
import type { RouteDef } from './route.ts';

export function openapi(routes: RouteDef[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const path = r.path.replace(/:([A-Za-z_]+)/g, '{$1}');
    const params = [...r.path.matchAll(/:([A-Za-z_]+)/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    for (const [name, schema] of Object.entries(r.query ?? {})) params.push({ name, in: 'query', required: false, schema } as never);
    if (r.needsReason) params.push({ name: 'X-Change-Reason', in: 'header', required: true, schema: { type: 'string' } } as never);
    const write = r.method !== 'get' && !r.public && !r.manualTx;
    if (write && r.idempotent !== false) params.push({ name: 'Idempotency-Key', in: 'header', required: false,
      description: 'UUID or 8-128 characters; required for apps. A retry with the same key returns the stored response (APP-DT-02)',
      schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{8,128}$' } } as never);
    if (write && r.versioned) params.push({ name: 'If-Match', in: 'header', required: false,
      description: 'row_version of the record as an entity tag ("3"); required for apps; 412 if the record changed (APP-DT-02)',
      schema: { type: 'string' } } as never);
    if (write && r.provenance !== false) for (const h of ['X-Source-Record-Id', 'X-Source-Version', 'X-Transformation-Id']) {
      params.push({ name: h, in: 'header', required: false, description: 'Provenance of the datum; required for apps (APP-DT-05)',
        schema: { type: 'string', maxLength: 200 } } as never);
    }
    (paths[path] ??= {})[r.method] = {
      summary: r.summary,
      tags: [r.tag],
      'x-requirements': r.reqs,
      ...(r.public ? { security: [] } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: r.body } } } } : {}),
      responses: {
        [String(r.status ?? 200)]: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
        default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'TrialOps Platform API', version: '0.1.0', license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' } },
    servers: [{ url: '/' }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'],
          properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
      },
    },
  };
}
