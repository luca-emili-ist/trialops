// What a caller may do (role) is checked here; on which platform/arm/site (perimeter) is checked by RLS (IAM-02).
import type { Claims } from '../auth.ts';
import { HttpError } from '../errors.ts';

export type Role = 'platform_admin' | 'platform_ops_manager' | 'arm_sponsor_lead' | 'ctm' | 'cra' | 'site_pi' | 'study_coordinator'
  | 'regulatory_lead' | 'safety_physician' | 'data_manager' | 'sac_member' | 'dsmb_member' | 'finance_controller' | 'qa_auditor';

export function requireRole(claims: Claims, allowed: Role[], action: string): void {
  const roles = claims.roles ?? [];
  if (!allowed.some(r => roles.includes(r))) {
    throw new HttpError(403, 'role_required', `${action} requires one of: ${allowed.join(', ')}`);
  }
}

/** Only a person can sign or decide on GxP content (AI-05, APP-TK-04); agents and apps cannot. */
export function requirePerson(claims: Claims, action: string): void {
  if ((claims.actor_type ?? 'user') !== 'user') throw new HttpError(403, 'person_required', `${action} must be done by a person`);
}
