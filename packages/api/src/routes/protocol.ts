// Structured Master Protocol and arm appendix editor (M01-01) on controlled versions (DM-02, CMP-02, IAM-05).
// Lifecycle: draft -> in_review -> approved (signed) -> superseded. Approved content is frozen by the database.
import sectionsSchema from '@trialops/schemas/protocol-sections.schema.json' with { type: 'json' };
import { route, uuid, type RouteDef } from '../route.ts';
import type { Db, Row } from '../db.ts';
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';
import { requireRole, type Role } from '../lib/roles.ts';
import { sign, signatureManifests } from '../lib/sign.ts';
import { ajv, check } from '../lib/validate.ts';
import { diffContent } from '../lib/diff.ts';
import type { Credential, Reauthenticator } from '../lib/reauth.ts';

export type ProtocolContent = Record<string, unknown>;
const validateContent = ajv.compile(sectionsSchema);
const SECTIONS = Object.keys(sectionsSchema.properties).filter(s => !['study', 'arm'].includes(s));
const sectionValidators = Object.fromEntries(SECTIONS.map(s =>
  [s, ajv.compile({ ...(sectionsSchema.properties as Record<string, object>)[s], $defs: sectionsSchema.$defs })]));

interface Kind {
  table: 'master_protocol_version' | 'arm_appendix_version';
  base: string;                       // /v1/protocol-versions | /v1/appendix-versions
  parentPath: string;                 // /v1/platforms/:id/protocol-versions | /v1/arms/:id/appendix-versions
  parentCol: 'platform_id' | 'arm_id';
  label: string;
  editRoles: Role[];
  approveRoles: Role[];
}

const MASTER: Kind = {
  table: 'master_protocol_version', base: '/v1/protocol-versions', parentPath: '/v1/platforms/:id/protocol-versions',
  parentCol: 'platform_id', label: 'Master Protocol', editRoles: ['platform_admin', 'platform_ops_manager', 'regulatory_lead'],
  approveRoles: ['platform_admin', 'regulatory_lead'],
};
const APPENDIX: Kind = {
  table: 'arm_appendix_version', base: '/v1/appendix-versions', parentPath: '/v1/arms/:id/appendix-versions',
  parentCol: 'arm_id', label: 'Arm appendix', editRoles: ['platform_admin', 'platform_ops_manager', 'regulatory_lead', 'arm_sponsor_lead'],
  approveRoles: ['platform_admin', 'regulatory_lead'],
};

const cols = 'id, platform_id, version_label, usdm, status, approved_signature_id, created_at, updated_at, row_version';
const colsFor = (k: Kind) => k.table === 'arm_appendix_version' ? `${cols}, arm_id, master_protocol_version_id, ai_provenance` : cols;

/** Adds the manifestation of the approval signature (CMP-11): name, meaning, UTC time, reason, authentication. */
export async function withApprovalSignature(db: Db, rows: Row[]): Promise<Row[]> {
  const m = await signatureManifests(db, rows.map(r => r.approved_signature_id));
  return rows.map(r => ({ ...r, approved_signature: r.approved_signature_id ? m.get(r.approved_signature_id) ?? null : null }));
}

export async function getVersion(db: Db, k: Kind, id: string): Promise<Row | undefined> {
  const r = (await db.query(`select ${colsFor(k)} from core.${k.table} where id = $1`, [id])).rows[0];
  return r ? (await withApprovalSignature(db, [r]))[0] : undefined;
}

/** Latest approved version under a parent, the base for a new draft. */
export async function approvedVersion(db: Db, k: Kind, parentId: string): Promise<Row | undefined> {
  return (await db.query(`select ${colsFor(k)} from core.${k.table} where ${k.parentCol} = $1 and status = 'approved'
    order by created_at desc limit 1`, [parentId])).rows[0];
}

export function validateProtocolContent(content: unknown, what = 'usdm'): ProtocolContent {
  return check<ProtocolContent>(validateContent, content, what);
}

/** Creates a draft version. Used by the editor and by the new-arm wizard (step 8). */
export async function createDraft(db: Db, claims: Claims, k: Kind, parentId: string, input: { version_label: string; usdm?: unknown; copy_from?: string })
  : Promise<Row> {
  requireRole(claims, k.editRoles, `Editing the ${k.label}`);
  let usdm = input.usdm;
  if (usdm === undefined) {
    const base = input.copy_from ? await getVersion(db, k, input.copy_from) : await approvedVersion(db, k, parentId);
    usdm = base?.usdm ?? {};
  }
  validateProtocolContent(usdm);
  if (k.table === 'master_protocol_version') {
    return (await db.query(`insert into core.master_protocol_version(platform_id, version_label, usdm) values ($1,$2,$3) returning ${colsFor(k)}`,
      [parentId, input.version_label, JSON.stringify(usdm)])).rows[0];
  }
  const arm = (await db.query('select id, platform_id from core.arm where id = $1', [parentId])).rows[0];
  if (!arm) throw new HttpError(404, 'not_found', 'arm not found');
  const master = await approvedVersion(db, MASTER, arm.platform_id);
  if (!master) throw new HttpError(422, 'no_master_protocol', 'the platform has no approved Master Protocol version');
  return (await db.query(`insert into core.arm_appendix_version(platform_id, arm_id, master_protocol_version_id, version_label, usdm)
    values ($1,$2,$3,$4,$5) returning ${colsFor(k)}`, [arm.platform_id, arm.id, master.id, input.version_label, JSON.stringify(usdm)])).rows[0];
}

async function draftOrFail(db: Db, k: Kind, id: string): Promise<Row> {
  const v = await getVersion(db, k, id);
  if (!v) throw new HttpError(404, 'not_found', `${k.label} version not found`);
  if (v.status !== 'draft') throw new HttpError(409, 'not_draft', `${k.label} version is ${v.status}: only drafts can be edited (DM-02)`);
  return v;
}

/** Replaces one section of a draft. The change reason comes from the request (DM-03). */
export async function putSection(db: Db, claims: Claims, k: Kind, id: string, section: string, content: unknown): Promise<Row> {
  requireRole(claims, k.editRoles, `Editing the ${k.label}`);
  const validate = sectionValidators[section];
  if (!validate) throw new HttpError(404, 'unknown_section', `unknown section ${section}; sections: ${SECTIONS.join(', ')}`);
  check(validate, content, section);
  await draftOrFail(db, k, id);
  return (await db.query(`update core.${k.table} set usdm = jsonb_set(usdm, $2, $3::jsonb, true) where id = $1 returning ${colsFor(k)}`,
    [id, [section], JSON.stringify(content)])).rows[0];
}

/** Approval: signature with re-authentication, then status change; the previous approved version is superseded. */
export async function approve(db: Db, claims: Claims, reauth: Reauthenticator | undefined, k: Kind, id: string, credential: Credential)
  : Promise<Row> {
  requireRole(claims, k.approveRoles, `Approving the ${k.label}`);
  const v = await getVersion(db, k, id);
  if (!v) throw new HttpError(404, 'not_found', `${k.label} version not found`);
  if (v.status !== 'in_review') throw new HttpError(409, 'not_in_review', `${k.label} version must be in review to be approved`);
  const sig = await sign(db, claims, reauth, { target_table: k.table, target_id: id, meaning: 'approval', credential });
  const parent = k.parentCol === 'arm_id' ? v.arm_id : v.platform_id;
  await db.query(`update core.${k.table} set status = 'superseded' where ${k.parentCol} = $1 and status = 'approved' and id <> $2`, [parent, id]);
  const out = (await db.query(`update core.${k.table} set status = 'approved', approved_signature_id = $2 where id = $1 returning ${colsFor(k)}`,
    [id, sig.id])).rows[0];
  return { ...out, approved_signature: sig, signature: sig };
}

function routesFor(k: Kind): RouteDef[] {
  const reqs = ['M01-01', 'DM-02'];
  const versioned = { table: k.table, param: 'vid' };
  return [
    route({ method: 'get', path: k.parentPath, summary: `${k.label} versions`, tag: 'protocol', reqs,
      handler: async ({ db, params }) => ({
        items: await withApprovalSignature(db, (await db.query(`select ${colsFor(k)} from core.${k.table} where ${k.parentCol} = $1
          and status <> 'void' order by created_at`, [params.id])).rows),
      }) }),
    route<{ version_label: string; usdm?: unknown; copy_from?: string }>({ method: 'post', path: k.parentPath, status: 201,
      summary: `New draft ${k.label} version (copies the approved one unless usdm or copy_from is given)`, tag: 'protocol', reqs,
      body: { type: 'object', required: ['version_label'], additionalProperties: false,
        properties: { version_label: { type: 'string', minLength: 1, maxLength: 40 }, usdm: { type: 'object' }, copy_from: uuid } },
      handler: async ({ db, claims, params, body }) => createDraft(db, claims, k, params.id!, body) }),
    route({ method: 'get', path: `${k.base}/:vid`, versioned, summary: `${k.label} version with approval signature manifestation and AI provenance`,
      tag: 'protocol', reqs: [...reqs, 'CMP-11', 'CMP-09'],
      handler: async ({ db, params }) => getVersion(db, k, params.vid!) }),
    route<{ content: unknown }>({ method: 'put', path: `${k.base}/:vid/sections/:section`, versioned, needsReason: true,
      summary: `Replace one structured section of a draft ${k.label} (ICH M11 / USDM)`, tag: 'protocol', reqs: ['M01-01', 'DM-02', 'DM-03'],
      body: { type: 'object', required: ['content'], properties: { content: {} } },
      handler: async ({ db, claims, params, body }) => putSection(db, claims, k, params.vid!, params.section!, body.content) }),
    route({ method: 'post', path: `${k.base}/:vid/submit`, versioned, needsReason: true, summary: `Send a draft ${k.label} to review`, tag: 'protocol', reqs,
      handler: async ({ db, claims, params }) => {
        requireRole(claims, k.editRoles, `Submitting the ${k.label}`);
        await draftOrFail(db, k, params.vid!);
        return (await db.query(`update core.${k.table} set status = 'in_review' where id = $1 returning ${colsFor(k)}`, [params.vid])).rows[0];
      } }),
    route({ method: 'post', path: `${k.base}/:vid/return`, versioned, needsReason: true, summary: `Return a ${k.label} in review to draft`, tag: 'protocol', reqs,
      handler: async ({ db, claims, params }) => {
        requireRole(claims, [...new Set([...k.editRoles, ...k.approveRoles])], `Returning the ${k.label}`);
        const r = (await db.query(`update core.${k.table} set status = 'draft' where id = $1 and status = 'in_review' returning ${colsFor(k)}`,
          [params.vid])).rows[0];
        if (!r) throw new HttpError(409, 'not_in_review', 'only versions in review can be returned to draft');
        return r;
      } }),
    route<{ password?: string; totp?: string }>({ method: 'post', path: `${k.base}/:vid/approve`, versioned, needsReason: true,
      summary: `Approve a ${k.label} version with a Part 11 signature`, tag: 'protocol', reqs: ['M01-01', 'DM-02', 'CMP-02', 'IAM-05', 'CMP-11'],
      body: { type: 'object', additionalProperties: false, properties: { password: { type: 'string' }, totp: { type: 'string', maxLength: 16 } } },
      handler: async ({ db, claims, params, body, services }) => approve(db, claims, services.reauth, k, params.vid!, { password: body.password, totp: body.totp }) }),
    route({ method: 'get', path: `${k.base}/:vid/diff`, summary: `Section diff of a ${k.label} version against another (default: approved)`,
      tag: 'protocol', reqs: ['M01-01', 'M01-02'], query: { against: uuid },
      handler: async ({ db, params, query }) => {
        const v = await getVersion(db, k, params.vid!);
        if (!v) return undefined;
        const base = query.against ? await getVersion(db, k, query.against)
          : await approvedVersion(db, k, k.parentCol === 'arm_id' ? v.arm_id : v.platform_id);
        return { version_id: v.id, against_id: base?.id ?? null, sections: diffContent(base?.usdm ?? {}, v.usdm) };
      } }),
  ];
}

export const PROTOCOL_KINDS = { MASTER, APPENDIX };
export const protocolRoutes: RouteDef[] = [...routesFor(MASTER), ...routesFor(APPENDIX),
  route({ method: 'get', path: '/v1/protocol-sections/schema', summary: 'JSON Schema of the structured protocol sections', tag: 'protocol',
    reqs: ['M01-01'], handler: async () => sectionsSchema })];
