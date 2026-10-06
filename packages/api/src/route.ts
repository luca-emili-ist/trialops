// Route registry: one declaration drives the Express handler, request validation and the OpenAPI 3.1 document
// (spec §3, "OpenAPI 3.1 generated from the code").
import type { Db } from './db.ts';
import type { Claims } from './auth.ts';
import type { Reauthenticator } from './lib/reauth.ts';
import type { AiRuntime } from '@trialops/ai-runtime';

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

/** Collaborators injected into handlers. */
export interface Services {
  ai?: AiRuntime;
  reauth?: Reauthenticator;
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
