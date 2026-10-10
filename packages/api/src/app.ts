// Platform API (ARC-03). createApp is used by the local server, the Netlify function and the tests.
import express, { type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import { bearer, type Verifier } from './auth.ts';
import { withClaims, ANONYMOUS, type Db } from './db.ts';
import { HttpError, toHttp } from './errors.ts';
import type { RawResponse, RouteDef, Services } from './route.ts';
import { openapi } from './openapi.ts';
import { ajv } from './lib/validate.ts';
import { routes as allRoutes } from './routes/index.ts';
import { accessConfigFromEnv, authTx, enforceAccessPolicy, policyReauth, SYSTEM_AUTH, type Deferred } from './lib/access-policy.ts';

/** ctx.db of a manualTx route: there is no request transaction, the handler must use ctx.tx. */
const NO_TX = new Proxy({}, { get() { throw new Error('manualTx route: use ctx.tx() to open a transaction'); } }) as Db;

export interface AppDeps {
  pool: pg.Pool;
  verify: Verifier;
  services?: Services;
  routes?: RouteDef[];
}

export function createApp({ pool, verify, services = {}, routes = allRoutes }: AppDeps): express.Express {
  const app = express();
  // The services seen by the routes: the given ones (read live, e.g. an OIDC provider set after start-up), the access policy
  // (IAM-01, CMP-03) and the signature re-authentication wrapped by that policy (MFA step-up, failures counted).
  const access = services.access ?? accessConfigFromEnv();
  let wrapped: { inner: unknown; outer: Services['reauth'] } = { inner: undefined, outer: undefined };
  const svc: Services = Object.create(services, {
    access: { value: access, enumerable: true },
    reauth: { enumerable: true, get: () => {
      if (wrapped.inner !== services.reauth) wrapped = { inner: services.reauth, outer: services.reauth && policyReauth(services.reauth, pool, access) };
      return wrapped.outer;
    } },
  });
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
        const after: (() => Promise<void> | void)[] = [];
        const claims = r.public ? ANONYMOUS : await verify(bearer(req.header('authorization')));
        // IAM-01, CMP-03: lockout, idle timeout and MFA for every authenticated route (lib/access-policy.ts)
        if (!r.public) await enforceAccessPolicy(pool, claims, access, !!r.allowBelowMfa);
        const ctxBase = { params: req.params as Record<string, string>, query: req.query as Record<string, string | undefined>,
          body: req.body as never, reason, services: svc, headers: req.headers as Record<string, string | undefined>, claims, access,
          tx: <T>(fn: (db: Db) => Promise<T>) => withClaims(pool, claims, r.public ? undefined : reason, fn),
          authTx: <T>(fn: (db: Db) => Promise<T>) => authTx(pool, r.public ? SYSTEM_AUTH : claims, fn),
          afterCommit: (fn: () => Promise<void> | void) => { after.push(fn); } };
        const out: unknown = r.manualTx ? await r.handler({ ...ctxBase, db: NO_TX })
          : await ctxBase.tx(db => r.handler({ ...ctxBase, db }));
        for (const fn of after) await fn();
        if (out === undefined) throw new HttpError(404, 'not_found', 'not found');
        if (r.raw) {
          const { status, headers, body } = out as RawResponse;
          // a string body is sent as is with the route's content type (e.g. the CSV export of the audit trail)
          if (typeof body === 'string') res.status(status).set(headers ?? {}).send(body); else res.status(status).set(headers ?? {}).json(body);
          return;
        }
        res.status(r.status ?? 200).json(out);
      } catch (e) {
        // e.g. a failed signature re-authentication, counted for the lockout once the request transaction rolled back
        const later = (e as Deferred | undefined)?.afterRollback;
        if (later) { try { next((await later()) ?? e); } catch (x) { next(x); } return; }
        next(e);
      }
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
