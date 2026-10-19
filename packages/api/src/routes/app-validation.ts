// Supplier validation of apps (VAL-04; Annex 11 §3/§4, ICH E6(R3) service providers): the supplier's validation package
// of an app version is received and reviewed by QA, contract test runs are recorded as facts, and the database refuses to
// activate an L2-L3 installation without both (0026, trigger gate_validation on core.app_installation).
import { route } from '../route.ts';
import type { Claims } from '../auth.ts';
import { requirePerson, requireRole } from '../lib/roles.ts';
import { HttpError } from '../errors.ts';

const APP_ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{1,99}$' } as const;
const VERSION = { type: 'string', minLength: 1, maxLength: 50 } as const;
const SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const CONTENTS = ['URS', 'functional_spec', 'risk_assessment', 'test_plan', 'test_evidence', 'traceability', 'release_note', 'sbom', 'security_assessment'];
const PKG_COLS = `id, app_id, version, gxp_class, provider_id, package_uri, package_sha256, contents, status, review_note, reviewed_by, reviewed_at,
  received_by, received_at, row_version`;

function qaOrAdmin(claims: Claims, action: string): void {
  requirePerson(claims, action);
  requireRole(claims, ['qa_auditor', 'platform_admin'], action);
}

export const appValidationRoutes = [
  route<{ app_id: string; version: string; gxp_class: string; provider_id: string; package_uri: string; package_sha256: string; contents: string[] }>({
    method: 'post', path: '/v1/apps/validation-packages', status: 201, tag: 'apps', reqs: ['VAL-04'],
    summary: 'Receive the supplier validation package of an app version (URI, SHA-256, contents); QA reviews it',
    body: { type: 'object', additionalProperties: false, required: ['app_id', 'version', 'gxp_class', 'provider_id', 'package_uri', 'package_sha256', 'contents'],
      properties: { app_id: APP_ID, version: VERSION, gxp_class: { enum: ['L0', 'L1', 'L2', 'L3'] }, provider_id: { type: 'string', format: 'uuid' },
        package_uri: { type: 'string', minLength: 1, maxLength: 1000 }, package_sha256: SHA256,
        contents: { type: 'array', uniqueItems: true, items: { enum: CONTENTS } } } },
    handler: async ({ db, claims, body }) => {
      qaOrAdmin(claims, 'Receiving a validation package');
      return (await db.query(`insert into core.app_validation_package(app_id, version, gxp_class, provider_id, package_uri, package_sha256, contents)
        values ($1, $2, $3, $4, $5, $6, $7) returning ${PKG_COLS}`,
      [body.app_id, body.version, body.gxp_class, body.provider_id, body.package_uri, body.package_sha256, body.contents])).rows[0];
    } }),

  route<{ outcome: 'accepted' | 'rejected'; note: string }>({ method: 'post', path: '/v1/app-validation-packages/:id/review',
    versioned: { table: 'app_validation_package', param: 'id' }, needsReason: true, tag: 'apps', reqs: ['VAL-04'],
    summary: 'QA review of a validation package: accepted or rejected with a note (L2-L3 must contain URS, risk assessment, test evidence, traceability)',
    body: { type: 'object', additionalProperties: false, required: ['outcome', 'note'], properties: { outcome: { enum: ['accepted', 'rejected'] },
      note: { type: 'string', minLength: 1, maxLength: 4000 } } },
    handler: async ({ db, claims, params, body }) => {
      requirePerson(claims, 'Reviewing a validation package');
      requireRole(claims, ['qa_auditor'], 'Reviewing a validation package');
      return (await db.query(`update core.app_validation_package set status = $2, review_note = $3 where id = $1 returning ${PKG_COLS}`,
        [params.id, body.outcome, body.note])).rows[0];
    } }),

  route<{ app_id: string; version: string; suite: string; suite_version: string; passed: number; failed: number; skipped?: number; evidence_uri: string;
    evidence_sha256: string }>({ method: 'post', path: '/v1/apps/contract-test-runs', status: 201, tag: 'apps', reqs: ['VAL-04'],
    summary: 'Record the result of a contract test run of an app version (pass = no failures and at least one passed test); append-only',
    body: { type: 'object', additionalProperties: false, required: ['app_id', 'version', 'suite', 'suite_version', 'passed', 'failed', 'evidence_uri', 'evidence_sha256'],
      properties: { app_id: APP_ID, version: VERSION, suite: APP_ID, suite_version: VERSION, passed: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 }, skipped: { type: 'integer', minimum: 0 }, evidence_uri: { type: 'string', minLength: 1, maxLength: 1000 },
        evidence_sha256: SHA256 } },
    handler: async ({ db, claims, body }) => {
      qaOrAdmin(claims, 'Recording a contract test run');
      return (await db.query(`insert into core.app_contract_test_run(app_id, version, suite, suite_version, passed, failed, skipped, evidence_uri, evidence_sha256)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, app_id, version, suite, suite_version, passed, failed, skipped, result, evidence_uri,
        evidence_sha256, recorded_by, executed_at`, [body.app_id, body.version, body.suite, body.suite_version, body.passed, body.failed, body.skipped ?? 0,
        body.evidence_uri, body.evidence_sha256])).rows[0];
    } }),

  route({ method: 'get', path: '/v1/apps/:app_id/validation', tag: 'apps', reqs: ['VAL-04'],
    summary: 'Activation gate of an app version: required for L2-L3, package and supplier status, latest contract test result, problems',
    query: { version: VERSION, gxp_class: { enum: ['L0', 'L1', 'L2', 'L3'] } },
    handler: async ({ db, params, query }) => {
      if (!query.version || !query.gxp_class) throw new HttpError(400, 'invalid_filter', 'version and gxp_class are required');
      const gate = (await db.query('select * from core.app_validation_gate($1, $2, $3)', [params.app_id, query.version, query.gxp_class])).rows[0];
      const packages = (await db.query(`select ${PKG_COLS} from core.app_validation_package where app_id = $1 and version = $2 and status <> 'void'
        order by received_at desc`, [params.app_id, query.version])).rows;
      const runs = (await db.query(`select id, suite, suite_version, passed, failed, skipped, result, evidence_uri, evidence_sha256, recorded_by, executed_at
        from core.app_contract_test_run where app_id = $1 and version = $2 order by executed_at desc limit 50`, [params.app_id, query.version])).rows;
      return { app_id: params.app_id, version: query.version, gxp_class: query.gxp_class, gate, packages, contract_test_runs: runs };
    } }),
];
