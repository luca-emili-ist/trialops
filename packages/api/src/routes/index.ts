import type { RouteDef } from '../route.ts';
import { platformRoutes } from './platform.ts';
import { armRoutes } from './arms.ts';
import { protocolRoutes } from './protocol.ts';
import { signatureRoutes } from './signatures.ts';
import { siteRoutes } from './sites.ts';
import { metricRoutes } from './metrics.ts';
import { aiRoutes } from './ai.ts';
import { taskRoutes } from './tasks.ts';
import { appRoutes } from './apps.ts';
import { devRoutes } from './dev.ts';
import { jobRoutes } from './jobs.ts';
import { auditRoutes } from './audit.ts';
import { authRoutes } from './auth.ts';
import { changeRoutes } from './changes.ts';

export const routes: RouteDef[] = [...platformRoutes, ...armRoutes, ...protocolRoutes, ...signatureRoutes, ...siteRoutes, ...metricRoutes, ...aiRoutes, ...jobRoutes, ...taskRoutes, ...appRoutes, ...auditRoutes, ...changeRoutes, ...authRoutes, ...devRoutes];
