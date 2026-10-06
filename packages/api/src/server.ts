// Local development server: `node packages/api/src/server.ts` (needs DATABASE_URL and a JWT key, see README).
import { createApp, createPool, createVerifier } from './index.ts';

const port = Number(process.env.PORT || 8787);
createApp({ pool: createPool(), verify: createVerifier() }).listen(port, () => console.log(`TrialOps API on http://localhost:${port}`));
