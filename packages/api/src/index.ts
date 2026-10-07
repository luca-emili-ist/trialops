// TrialOps Platform API (ARC-03).
export { createApp, type AppDeps } from './app.ts';
export { createVerifier, type Claims, type Verifier } from './auth.ts';
export { createPool, withClaims } from './db.ts';
export { openapi } from './openapi.ts';
export { routes } from './routes/index.ts';
export { executeJob } from './routes/jobs.ts';
export type { JobDispatcher, Services } from './route.ts';
export const API_VERSION = 'v1';
