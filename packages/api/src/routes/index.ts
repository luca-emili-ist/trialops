import type { RouteDef } from '../route.ts';
import { platformRoutes } from './platform.ts';

export const routes: RouteDef[] = [...platformRoutes];
