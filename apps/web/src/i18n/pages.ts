// Pages in English and Japanese (site- and subject-facing, NFR-07); the other pages are in English only (platform
// administration, sponsor and operator work). Paths relative to apps/web/src. Checked by test/i18n.test.ts.
export const SITE_FACING_PAGES = ['App.tsx', 'session.tsx', 'pages/Login.tsx', 'pages/Dashboard.tsx', 'pages/Sites.tsx', 'pages/Tasks.tsx',
  'pages/NotFound.tsx', 'pages/OidcAuthorize.tsx',
  // EDC (M06b, TRO-070…TRO-075): data entry and queries are done by site staff; the CRF library is read by them too
  'pages/EdcDataEntry.tsx', 'pages/EdcQueries.tsx', 'pages/EdcLibrary.tsx'];
