// Shared helpers of the EDC pages (TRO-070…TRO-075). Times are shown in UTC with the zone (rule 11).
import type { Tone } from '@trialops/shell';

/** Roles that read subject-level EDC data (same list as core.edc_reader_roles, migration 0027). */
export const EDC_READER_ROLES = ['platform_admin', 'platform_ops_manager', 'ctm', 'cra', 'site_pi', 'study_coordinator', 'data_manager',
  'safety_physician', 'qa_auditor'] as const;
export const EDC_SITE_ROLES = ['site_pi', 'study_coordinator'] as const;
export const EDC_REVIEW_ROLES = ['data_manager', 'cra'] as const;
export const EDC_LIBRARY_ROLES = ['data_manager', 'platform_admin'] as const;

export const utc = (v?: string | null) => v ? `${new Date(v).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—';
export const today = () => new Date().toISOString().slice(0, 10);

/** Colour only for what needs action (P3): an open query is an anomaly, an answered one waits for review. */
export const queryTone = (s: string): Tone => (s === 'open' ? 'warn' : s === 'answered' ? 'info' : 'neutral');

export interface EdcQuery { id: string; status: string; origin: string; question: string; answer: string | null; close_reason: string | null;
  item_oid: string | null; check_code: string | null; opened_by: string; opened_at: string; answered_by: string | null; answered_at: string | null;
  closed_by: string | null; closed_at: string | null }
