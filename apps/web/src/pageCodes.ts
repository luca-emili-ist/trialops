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
  login: 'TRO-090',
  notFound: 'TRO-098',
  uiCatalogue: 'TRO-099',
} as const;
export type PageKey = keyof typeof PAGE_CODES;
