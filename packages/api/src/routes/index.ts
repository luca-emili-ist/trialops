import type { RouteDef } from '../route.ts';
import { platformRoutes } from './platform.ts';
import { armRoutes } from './arms.ts';
import { protocolRoutes } from './protocol.ts';
import { signatureRoutes } from './signatures.ts';
import { siteRoutes } from './sites.ts';
import { metricRoutes } from './metrics.ts';
import { aiRoutes } from './ai.ts';
import { aiGovernanceRoutes } from './ai-governance.ts';
import { taskRoutes } from './tasks.ts';
import { appRoutes } from './apps.ts';
import { devRoutes } from './dev.ts';
import { jobRoutes } from './jobs.ts';
import { auditRoutes } from './audit.ts';
import { authRoutes } from './auth.ts';
import { changeRoutes } from './changes.ts';
import { accessLogRoutes } from './access-log.ts';
import { certifiedCopyRoutes } from './certified-copies.ts';
import { governanceRoutes } from './governance.ts';
import { privacyRoutes } from './privacy.ts';
import { appValidationRoutes } from './app-validation.ts';
import { edcRoutes } from './edc.ts';

export const routes: RouteDef[] = [...platformRoutes, ...armRoutes, ...protocolRoutes, ...signatureRoutes, ...siteRoutes, ...metricRoutes, ...aiRoutes, ...aiGovernanceRoutes, ...jobRoutes, ...taskRoutes, ...appRoutes, ...auditRoutes, ...accessLogRoutes, ...certifiedCopyRoutes, ...changeRoutes, ...authRoutes, ...devRoutes];
// v1 quality and privacy governance (CMP-05, CMP-08, VAL-04)
routes.push(...governanceRoutes, ...privacyRoutes, ...appValidationRoutes);
// v1 native EDC, module M06b (EDC-01, EDC-03, EDC-04, EDC-05, EDC-11, EDC-12)
routes.push(...edcRoutes);
