// App catalogue, installation with scope approval (APP-MF-01/02/04), app roles (APP-ID-04) and OIDC SSO (APP-ID-01/02).
import simulationTa1 from '@trialops/schemas/catalogue/ist.simulation-ta1.manifest.json' with { type: 'json' };
import ta1TestApp from '@trialops/schemas/catalogue/ist.ta1-test-app.manifest.json' with { type: 'json' };
import manifestSchema from '@trialops/schemas/app-manifest.schema.json' with { type: 'json' };
import { route, uuid, type RawResponse } from '../route.ts';
import type { Db, Row } from '../db.ts';
import { HttpError } from '../errors.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { ajv } from '../lib/validate.ts';
import { discovery, newCode, s256, sha256hex, signToken, verifyAccessToken, type Oidc } from '../lib/oidc.ts';

const validateManifest = ajv.compile(manifestSchema);
const ADMIN = ['platform_admin'] as const;

/** Published manifests (packages/schemas/catalogue), bundled with the code. */
export function catalogue(): Row[] {
  return [simulationTa1, ta1TestApp].map(m => structuredClone(m) as Row).sort((a, b) => a.app_id.localeCompare(b.app_id));
}

async function getInstallation(db: Db, id: string): Promise<Row | undefined> {
  const i = (await db.query(`select id, app_id, version, gxp_class, platform_id, status, approved_by, approved_at, uninstalled_at, manifest,
    validation_package_id, contract_test_run_id, created_at from core.app_installation where id = $1`, [id])).rows[0];
  if (!i) return undefined;
  const scopes = (await db.query('select scope, granted_at, revoked_at from core.app_scope_grant where installation_id = $1 order by scope', [id])).rows;
  return { ...i, scopes };
}

function oidcOrFail(o: Oidc | undefined): Oidc {
  if (!o) throw new HttpError(501, 'oidc_unavailable', 'OIDC provider not configured');
  return o;
}
const oauthError = (status: number, error: string, description: string): RawResponse =>
  ({ status, headers: { 'cache-control': 'no-store' }, body: { error, error_description: description } });

export const appRoutes = [
  route({ method: 'get', path: '/v1/apps/catalogue', summary: 'Published apps: publisher, GxP class, scopes, residency, validation package',
    tag: 'apps', reqs: ['APP-MF-01'],
    handler: async () => ({ items: catalogue().map(m => ({ app_id: m.app_id, version: m.version, publisher: m.publisher, gxp_class: m.gxp_class,
      hosting: m.hosting, scopes: m.scopes, roles: m.roles ?? [], data_residency: m.data_residency,
      validation_package: m.validation_package_url ?? null, valid: validateManifest(m), manifest: m })) }) }),

  route({ method: 'get', path: '/v1/platforms/:id/apps', summary: 'Apps installed on a platform', tag: 'apps', reqs: ['APP-MF-02'],
    handler: async ({ db, params }) => {
      const ids = (await db.query("select id from core.app_installation where platform_id = $1 and status <> 'void' order by app_id", [params.id])).rows;
      const items = [];
      for (const r of ids) items.push(await getInstallation(db, r.id));
      return { items };
    } }),

  route<{ manifest: Row }>({ method: 'post', path: '/v1/platforms/:id/apps', status: 201, tag: 'apps', reqs: ['APP-MF-01', 'APP-MF-02'],
    summary: 'Request the installation of an app; the manifest is validated and the scopes wait for approval',
    body: { type: 'object', additionalProperties: false, required: ['manifest'], properties: { manifest: { type: 'object' } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, [...ADMIN], 'Installing an app');
      const m = body.manifest;
      if (!validateManifest(m)) {
        throw new HttpError(422, 'invalid_manifest', `manifest rejected (APP-MF-01): ${ajv.errorsText(validateManifest.errors, { dataVar: 'manifest' })}`);
      }
      const existing = (await db.query('select id, status from core.app_installation where app_id = $1 and platform_id = $2', [m.app_id, params.id])).rows[0];
      let id: string;
      if (!existing) {
        id = (await db.query(`insert into core.app_installation(app_id, version, manifest, gxp_class, platform_id) values ($1,$2,$3,$4,$5) returning id`,
          [m.app_id, m.version, JSON.stringify(m), m.gxp_class, params.id])).rows[0].id;
      } else if (['pending_approval', 'uninstalled'].includes(existing.status)) {
        id = existing.id;
        await db.query(`update core.app_installation set version = $2, manifest = $3, gxp_class = $4, status = 'pending_approval',
          approved_by = null where id = $1`, [id, m.version, JSON.stringify(m), m.gxp_class]);
      } else {
        throw new HttpError(409, 'already_installed', `app is ${existing.status} on this platform`);
      }
      return getInstallation(db, id);
    } }),

  route({ method: 'post', path: '/v1/app-installations/:id/approve', versioned: { table: 'app_installation', param: 'id' }, tag: 'apps', reqs: ['APP-MF-02', 'VAL-04', 'CMP-08'],
    summary: 'Approve the scopes requested by an app (the app becomes active); L2-L3 need the accepted validation package and passing contract tests',
    handler: async ({ db, claims, params }) => {
      requirePerson(claims, 'Approving app scopes');
      requireRole(claims, [...ADMIN], 'Approving app scopes');
      const i = await getInstallation(db, params.id!);
      if (!i) return undefined;
      if (i.status !== 'pending_approval') throw new HttpError(409, 'not_pending', `installation is ${i.status}`);
      if (!validateManifest(i.manifest)) throw new HttpError(422, 'invalid_manifest', 'stored manifest is not valid (APP-MF-01): reinstall');
      await db.query("update core.app_installation set status = 'active', approved_by = $2 where id = $1", [i.id, claims.sub]);
      return getInstallation(db, i.id);
    } }),

  route({ method: 'post', path: '/v1/app-installations/:id/uninstall', versioned: { table: 'app_installation', param: 'id' }, tag: 'apps', reqs: ['APP-MF-04'],
    summary: 'Uninstall an app: scopes and sign-in are revoked at once, data already written stays in the core',
    handler: async ({ db, claims, params }) => {
      requireRole(claims, [...ADMIN], 'Uninstalling an app');
      const i = await getInstallation(db, params.id!);
      if (!i) return undefined;
      if (i.status !== 'active' && i.status !== 'suspended') throw new HttpError(409, 'not_active', `installation is ${i.status}`);
      await db.query("update core.app_installation set status = 'uninstalled' where id = $1", [i.id]);
      return getInstallation(db, i.id);
    } }),

  route<{ person_id: string; role: string }>({ method: 'post', path: '/v1/app-installations/:id/role-assignments', status: 201, tag: 'apps',
    reqs: ['APP-ID-02'], summary: 'Assign an app role (declared in the manifest) to a person',
    body: { type: 'object', additionalProperties: false, required: ['person_id', 'role'], properties: { person_id: uuid, role: { type: 'string' } } },
    handler: async ({ db, claims, params, body }) => {
      requireRole(claims, [...ADMIN], 'Assigning app roles');
      const i = await getInstallation(db, params.id!);
      if (!i) return undefined;
      return (await db.query(`insert into core.app_role_assignment(platform_id, installation_id, person_id, role) values ($1,$2,$3,$4)
        returning id, installation_id, person_id, role, status`, [i.platform_id, i.id, body.person_id, body.role])).rows[0];
    } }),

  // ---- OpenID Provider ----
  route({ method: 'get', path: '/.well-known/openid-configuration', public: true, tag: 'oidc', reqs: ['APP-ID-01'],
    summary: 'OpenID Provider metadata', handler: async ({ services }) => discovery(oidcOrFail(services.oidc)) }),
  route({ method: 'get', path: '/oidc/jwks', public: true, tag: 'oidc', reqs: ['APP-ID-01'], summary: 'Public signing keys',
    handler: async ({ services }) => ({ keys: [oidcOrFail(services.oidc).publicJwk] }) }),

  route<{ client_id: string; platform_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: 'S256'; state?: string;
    nonce?: string; scope?: string }>({
    method: 'post', path: '/v1/oidc/authorize', idempotent: false, tag: 'oidc', reqs: ['APP-ID-01'],
    summary: 'Called by the web shell for the signed-in user: issues a code for the app (no new login)',
    body: { type: 'object', additionalProperties: false, required: ['client_id', 'platform_id', 'redirect_uri', 'code_challenge', 'code_challenge_method'],
      properties: { client_id: { type: 'string' }, platform_id: uuid, redirect_uri: { type: 'string', format: 'uri' },
        code_challenge: { type: 'string', minLength: 43, maxLength: 128 }, code_challenge_method: { const: 'S256' },
        state: { type: 'string', maxLength: 512 }, nonce: { type: 'string', maxLength: 512 }, scope: { type: 'string' } } },
    handler: async ({ db, body, services }) => {
      oidcOrFail(services.oidc);
      const code = newCode();
      await db.query('select core.oidc_issue_code($1,$2,$3,$4,$5,$6)',
        [sha256hex(code), body.client_id, body.platform_id, body.redirect_uri, body.code_challenge, body.nonce ?? null]);
      const u = new URL(body.redirect_uri);
      u.searchParams.set('code', code);
      if (body.state) u.searchParams.set('state', body.state);
      return { redirect_to: u.toString() };
    } }),

  route<Record<string, string>>({ method: 'post', path: '/oidc/token', public: true, raw: true, tag: 'oidc', reqs: ['APP-ID-01', 'APP-ID-02'],
    summary: 'Token endpoint (authorization_code + PKCE, public clients)',
    handler: async ({ db, body, services }) => {
      const o = oidcOrFail(services.oidc);
      if (body.grant_type !== 'authorization_code') return oauthError(400, 'unsupported_grant_type', 'only authorization_code');
      for (const k of ['code', 'redirect_uri', 'client_id', 'code_verifier']) {
        if (typeof body[k] !== 'string' || !body[k]) return oauthError(400, 'invalid_request', `${k} required`);
      }
      const c = (await db.query('select core.oidc_redeem_code($1,$2,$3,$4) c',
        [sha256hex(body.code!), body.client_id, body.redirect_uri, s256(body.code_verifier!)])).rows[0].c as Row;
      if (c.error) return oauthError(400, c.error, c.error_description);
      const { nonce, scopes, gxp_class: _g, app_id, person_id: _p, ...identity } = c;
      const id_token = await signToken(o, { ...identity, ...(nonce ? { nonce } : {}) }, app_id);
      const access_token = await signToken(o, { ...identity, client_id: app_id, scope: (scopes as string[]).join(' ') }, `${o.issuer}/oidc/userinfo`);
      return { status: 200, headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
        body: { token_type: 'Bearer', expires_in: 300, id_token, access_token, scope: 'openid' } };
    } }),

  route({ method: 'get', path: '/oidc/userinfo', public: true, tag: 'oidc', reqs: ['APP-ID-02'], summary: 'Claims of the signed-in user',
    handler: async ({ services, headers }) => {
      const o = oidcOrFail(services.oidc);
      const m = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '');
      if (!m?.[1]) throw new HttpError(401, 'invalid_token', 'Bearer access token required');
      const { iss: _i, aud: _a, iat: _t, exp: _e, client_id: _c, scope: _s, ...claims } = await verifyAccessToken(o, m[1]);
      return claims;
    } }),
];
