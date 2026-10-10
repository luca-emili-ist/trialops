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
  login: 'TRO-090',
  loginMfa: 'TRO-091',        // sign-in step: authenticator code (IAM-01); not a route, part of the sign-in
  loginMfaEnrol: 'TRO-092',   // sign-in step: enrolment of a first authenticator (IAM-01)
  notFound: 'TRO-098',
  uiCatalogue: 'TRO-099',
} as const;
export type PageKey = keyof typeof PAGE_CODES;
