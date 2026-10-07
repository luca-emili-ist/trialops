// Ports of the end-to-end stack (distinct from dev:api :8787 / db :54329 / web :5173 / TA1 :5174).
import { join } from 'node:path';

export const E2E = {
  pgPort: Number(process.env.TRIALOPS_E2E_PGPORT || 54349),
  pgData: process.env.TRIALOPS_E2E_PGDATA || join(import.meta.dirname, '..', '.pgdata-e2e'),
  apiPort: 8797,
  webPort: 5183,
  ta1Port: 5184,
  get apiUrl() { return `http://localhost:${this.apiPort}`; },
  get webUrl() { return `http://localhost:${this.webPort}`; },
};
