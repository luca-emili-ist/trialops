// Catalogues of the web app merged with those of the shell (NFR-07). To localise a new site- or subject-facing page
// (e.g. the EDC pages of M06b): wrap its texts in t('English text') from useT(), add the Japanese to ./ja.ts (or to a
// module catalogue merged here), and list the page file in SITE_FACING_PAGES (./pages.ts) so the completeness test covers it.
import { mergeCatalogues, SHELL_CATALOGUES, type Catalogues } from '@trialops/shell';
import { WEB_JA } from './ja.ts';

export const CATALOGUES: Catalogues = mergeCatalogues(SHELL_CATALOGUES, { ja: WEB_JA });
export { SITE_FACING_PAGES } from './pages.ts';
