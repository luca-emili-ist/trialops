// End-to-end scenario of demo v0 (Proposers' Day, 4 Nov 2026) against the local stack: embedded PostgreSQL freshly reset
// and seeded with synthetic data, Platform API with the demo user switch and AI in replay mode, web app (Vite).
// Ports and data directory differ from `npm run dev:api` / `dev:web`, so it runs while those are up. Run: npm run e2e
import { defineConfig, devices } from '@playwright/test';
import { E2E } from './e2e/ports.ts';

const stackEnv = { TRIALOPS_PGPORT: String(E2E.pgPort), TRIALOPS_PGDATA: E2E.pgData, PORT: String(E2E.apiPort),
  TRIALOPS_ISSUER: E2E.apiUrl, TRIALOPS_WEB_URL: E2E.webUrl, TRIALOPS_DEV_LOGIN: '1', TRIALOPS_AI_MODE: 'replay' };

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  outputDir: 'e2e/results',
  use: { baseURL: E2E.webUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  webServer: [
    { command: 'node scripts/db.mjs reset && node scripts/dev.mjs', env: stackEnv, url: `${E2E.apiUrl}/v1/openapi.json`,
      timeout: 180_000, reuseExistingServer: false, stdout: 'pipe' },
    { command: `npm run dev -w @trialops/web -- --port ${E2E.webPort} --strictPort`, url: E2E.webUrl, timeout: 60_000, reuseExistingServer: false,
      // empty Supabase settings: the web app uses the local demo user switch, never a real account
      env: { TRIALOPS_API_URL: E2E.apiUrl, VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' } },
  ],
});
