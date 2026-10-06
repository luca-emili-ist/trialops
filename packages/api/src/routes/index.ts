import type { RouteDef } from '../route.ts';
import { platformRoutes } from './platform.ts';
import { armRoutes } from './arms.ts';
import { protocolRoutes } from './protocol.ts';
import { signatureRoutes } from './signatures.ts';

export const routes: RouteDef[] = [...platformRoutes, ...armRoutes, ...protocolRoutes, ...signatureRoutes];
