// Route registry: one declaration drives the Express handler, request validation and the OpenAPI 3.1 document
// (spec §3, "OpenAPI 3.1 generated from the code").
import type { Db } from './db.ts';
import type { Claims } from './auth.ts';
import type { Reauthenticator } from './lib/reauth.ts';
import type { AiRuntime } from '@trialops/ai-runtime';
import type { Oidc } from './lib/oidc.ts';

export type JsonSchema = Record<string, unknown>;

export interface Ctx<B = unknown> {
  db: Db;
  claims: Claims;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: B;
  reason: string | undefined;
  headers: Record<string, string | undefined>;
  services: Services;
}

/** Collaborators injected into handlers. */
export interface Services {
  ai?: AiRuntime;
  reauth?: Reauthenticator;
  oidc?: Oidc;
  /** Local development only (TRIALOPS_DEV_LOGIN=1): mints a token for a demo user, for the user switch (DEMO-02). */
  devLogin?: (sub: string) => Promise<string>;
  devUsers?: () => Promise<Record<string, unknown>[]>;
}

export interface RawResponse { status: number; headers?: Record<string, string>; body: unknown }

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
  /** Public routes skip authentication (health, OIDC discovery and token endpoint) and run as the anon role. */
  public?: boolean;
  /** The handler returns a RawResponse (own status/headers/body), e.g. OAuth error responses. */
  raw?: boolean;
  handler: (ctx: Ctx<never>) => Promise<unknown>;
}

export const route = <B>(def: Omit<RouteDef, 'handler'> & { handler: (ctx: Ctx<B>) => Promise<unknown> }): RouteDef =>
  def as RouteDef;

export const uuid = { type: 'string', format: 'uuid' } as const;
