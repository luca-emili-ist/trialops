// Route registry: one declaration drives the Express handler, request validation and the OpenAPI 3.1 document
// (spec §3, "OpenAPI 3.1 generated from the code").
import type { Db } from './db.ts';
import type { Claims } from './auth.ts';

export type JsonSchema = Record<string, unknown>;

export interface Ctx<B = unknown> {
  db: Db;
  claims: Claims;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: B;
  reason: string | undefined;
  services: Services;
}

/** Collaborators injected into handlers (AI runtime client, clock...). Filled in by later steps. */
export interface Services {
  ai?: AiClient;
}

export interface AiTaskRequest {
  task_type: string;
  data_class: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL_SPONSOR' | 'CLINICAL_PSEUDONYMIZED' | 'STRICT_LOCAL';
  input: Record<string, unknown>;
  platform_id?: string;
  arm_id?: string;
  task_id?: string;
}
export interface AiTaskResult {
  ai_request_id: string;
  output: Record<string, unknown>;
}
export interface AiClient {
  run(req: AiTaskRequest, caller: { db: Db; claims: Claims }): Promise<AiTaskResult>;
}

export interface RouteDef {
  method: 'get' | 'post' | 'patch' | 'put';
  path: string;                  // Express syntax: /v1/arms/:id
  summary: string;
  tag: string;
  reqs: string[];                // requirement IDs, shown in OpenAPI as x-requirements
  body?: JsonSchema;
  query?: Record<string, JsonSchema>;
  status?: number;
  /** GxP writes must carry a change reason (DM-03); the API reads it from the X-Change-Reason header. */
  needsReason?: boolean;
  /** Public routes skip authentication (health, OpenAPI document, OIDC discovery). */
  public?: boolean;
  handler: (ctx: Ctx<never>) => Promise<unknown>;
}

export const route = <B>(def: Omit<RouteDef, 'handler'> & { handler: (ctx: Ctx<B>) => Promise<unknown> }): RouteDef =>
  def as RouteDef;

export const uuid = { type: 'string', format: 'uuid' } as const;
