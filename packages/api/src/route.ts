// Route registry: one declaration drives the Express handler, request validation and the OpenAPI 3.1 document
// (spec §3, "OpenAPI 3.1 generated from the code").
import type { Db } from './db.ts';
import type { Claims } from './auth.ts';
import type { Reauthenticator } from './lib/reauth.ts';
import type { AiRuntime } from '@trialops/ai-runtime';
import type { Oidc } from './lib/oidc.ts';
import type { AuthProvider } from './lib/auth-provider.ts';
import type { AccessConfig } from './lib/access-policy.ts';
import type { VersionedRecord } from './lib/write-controls.ts';
import type { DecisionSigner } from './lib/decision-signing.ts';

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
  /** Runs fn in a new transaction as the caller (own claims, RLS and audit apply). For routes with manualTx. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Runs fn after the request transaction committed and before the response is sent (e.g. dispatching a job). */
  afterCommit(fn: () => Promise<void> | void): void;
  /** Access policy in force (MFA, lockout, idle timeout: IAM-01, CMP-03). */
  access: AccessConfig;
  /** Runs fn in its own transaction as the role auth_service (sign-in bookkeeping of 0018); actor = the caller, or
   * system:auth on public routes. */
  authTx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

/** Collaborators injected into handlers. */
export interface Services {
  ai?: AiRuntime;
  reauth?: Reauthenticator;
  /** Identity provider called by the server: sign-in, MFA verification (Supabase Auth; tests: localAuth). */
  auth?: AuthProvider;
  /** Access policy; default from the environment (accessConfigFromEnv). */
  access?: AccessConfig;
  oidc?: Oidc;
  /** Local development only (TRIALOPS_DEV_LOGIN=1): mints a token for a demo user, for the user switch (DEMO-02). */
  devLogin?: (sub: string) => Promise<string>;
  devUsers?: () => Promise<Record<string, unknown>[]>;
  /** Starts the worker of an AI job (Netlify: the background function). Absent: the job runs in this process. */
  jobs?: JobDispatcher;
  /** Signer of the Agent Decision Records (AI-08); default from the environment (decisionSignerFromEnv). */
  decisions?: DecisionSigner;
}

/** Hands a queued AI job to a worker. Must return quickly: the worker answers 202 and runs the job on its own. */
export interface JobDispatcher {
  dispatch(jobId: string, request: { authorization?: string; cookie?: string }): Promise<void>;
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
  /** No request transaction: the handler opens its own with ctx.tx (long work split into several commits). */
  manualTx?: boolean;
  /** Reachable by a person whose token is not yet MFA-satisfied (aal1): the routes of the sign-in itself (IAM-01). */
  allowBelowMfa?: boolean;
  /** The route reads or updates one versioned record (row_version): GET answers with its ETag, writes honour If-Match
   * (412 on a stale version; required for apps) and answer with the new ETag (APP-DT-02). */
  versioned?: VersionedRecord;
  /** false: the write is not replayable (e.g. it returns a one-time secret): no Idempotency-Key, no stored response. */
  idempotent?: false;
  /** false: the write does not create or change data that needs app provenance (e.g. an AI request, ledgered by AI-06). */
  provenance?: false;
  handler: (ctx: Ctx<never>) => Promise<unknown>;
}

export const route = <B>(def: Omit<RouteDef, 'handler'> & { handler: (ctx: Ctx<B>) => Promise<unknown> }): RouteDef =>
  def as RouteDef;

export const uuid = { type: 'string', format: 'uuid' } as const;
