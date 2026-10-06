// Platform API (ARC-03). createApp is used by the local server, the Netlify function and the tests.
import express, { type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import { bearer, type Verifier } from './auth.ts';
import { withClaims, ANONYMOUS } from './db.ts';
import { HttpError, toHttp } from './errors.ts';
import type { RawResponse, RouteDef, Services } from './route.ts';
import { openapi } from './openapi.ts';
import { ajv } from './lib/validate.ts';
import { routes as allRoutes } from './routes/index.ts';

export interface AppDeps {
  pool: pg.Pool;
  verify: Verifier;
  services?: Services;
  routes?: RouteDef[];
}

export function createApp({ pool, verify, services = {}, routes = allRoutes }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));   // OAuth token endpoint (form-encoded)

  app.get('/v1/openapi.json', (_req, res) => { res.json(openapi(routes)); });

  for (const r of routes) {
    const validate = r.body ? ajv.compile(r.body) : null;
    app[r.method](r.path, async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (validate && !validate(req.body)) {
          throw new HttpError(400, 'invalid_body', ajv.errorsText(validate.errors, { dataVar: 'body' }));
        }
        const reason = req.header('x-change-reason')?.trim() || undefined;
        if (r.needsReason && !reason) throw new HttpError(400, 'reason_required', 'X-Change-Reason header required for this change (DM-03)');
        const ctxBase = { params: req.params as Record<string, string>, query: req.query as Record<string, string | undefined>,
          body: req.body as never, reason, services, headers: req.headers as Record<string, string | undefined> };
        let out: unknown;
        if (r.public) {
          out = await withClaims(pool, ANONYMOUS, undefined, db => r.handler({ ...ctxBase, db, claims: ANONYMOUS }));
        } else {
          const claims = await verify(bearer(req.header('authorization')));
          out = await withClaims(pool, claims, reason, db => r.handler({ ...ctxBase, db, claims }));
        }
        if (out === undefined) throw new HttpError(404, 'not_found', 'not found');
        if (r.raw) { const { status, headers, body } = out as RawResponse; res.status(status).set(headers ?? {}).json(body); return; }
        res.status(r.status ?? 200).json(out);
      } catch (e) { next(e); }
    });
  }

  app.use((_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'not_found', 'no such route')));
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const h = toHttp(e);
    if (h.status >= 500) console.error(e);
    res.status(h.status).json({ error: { code: h.code, message: h.message } });
  });
  return app;
}
