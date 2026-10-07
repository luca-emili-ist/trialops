import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the Platform API runs on :8787 (npm run dev:api); the web app proxies to it so both share one origin.
const api = process.env.TRIALOPS_API_URL ?? 'http://localhost:8787';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: Object.fromEntries(['/v1', '/api', '/oidc', '/.well-known'].map(p => [p, api])) },
  build: { outDir: 'dist', sourcemap: true },
});
