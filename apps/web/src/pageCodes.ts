// Stable page codes (house rule §19): one entry per route, never reused. Tested for uniqueness and coverage.
export const PAGE_CODES = {
  dashboard: 'TRO-001',
  arms: 'TRO-010',
  armDetail: 'TRO-011',
  armWizard: 'TRO-012',
  protocolEditor: 'TRO-013',
  sites: 'TRO-020',
  siteDetail: 'TRO-021',
  tasks: 'TRO-030',
  taskDetail: 'TRO-031',
  apps: 'TRO-040',
  oidcAuthorize: 'TRO-041',
  aiLedger: 'TRO-050',
  auditTrail: 'TRO-051',
  aiMonitoring: 'TRO-052',    // AI-10 monitoring per task type, autonomy per task type (AI-08 decision record anomalies)
  pendingActions: 'TRO-053',  // AI-07/AI-08 agent actions held for a person: confirm or reject
  quality: 'TRO-054',         // CMP-05 CtQ factors, risk register, KRIs/QTLs
  providers: 'TRO-055',       // CMP-05/CMP-08 service providers, agreements, oversight
  privacy: 'TRO-056',         // CMP-08 privacy self-check, data residency (NFR-06), ROPA
  appValidation: 'TRO-057',   // VAL-04 activation gate of L2-L3 apps
  changeRequests: 'TRO-060',  // Admin: triage of the changes suggested from the pages (UX-02)
  login: 'TRO-090',
  loginMfa: 'TRO-091',        // sign-in step: authenticator code (IAM-01); not a route, part of the sign-in
  loginMfaEnrol: 'TRO-092',   // sign-in step: enrolment of a first authenticator (IAM-01)
  notFound: 'TRO-098',
  uiCatalogue: 'TRO-099',
} as const;
export type PageKey = keyof typeof PAGE_CODES;
