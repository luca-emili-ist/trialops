// Hash router: #/path?query. Works on static hosting without server rewrites.
import { useEffect, useState } from 'react';
import type { PageKey } from './pageCodes.ts';

export interface Route { page: PageKey; params: Record<string, string> }

const TABLE: [RegExp, PageKey, string[]][] = [
  [/^\/$/, 'dashboard', []],
  [/^\/arms$/, 'arms', []],
  [/^\/arms\/new$/, 'armWizard', []],
  [/^\/arms\/([0-9a-f-]{36})$/, 'armDetail', ['id']],
  [/^\/protocol\/(master|appendix)\/([0-9a-f-]{36})$/, 'protocolEditor', ['kind', 'id']],
  [/^\/sites$/, 'sites', []],
  [/^\/sites\/([0-9a-f-]{36})$/, 'siteDetail', ['id']],
  [/^\/tasks$/, 'tasks', []],
  [/^\/tasks\/([0-9a-f-]{36})$/, 'taskDetail', ['id']],
  [/^\/apps$/, 'apps', []],
  [/^\/oidc\/authorize$/, 'oidcAuthorize', []],
  [/^\/ai$/, 'aiLedger', []],
  [/^\/audit$/, 'auditTrail', []],
  [/^\/change-requests$/, 'changeRequests', []],
  [/^\/login$/, 'login', []],
  [/^\/ui$/, 'uiCatalogue', []],
];
export const ROUTE_PATTERNS = TABLE.map(([re, page]) => ({ re, page }));

export function parse(hash: string): Route {
  const path = (hash.replace(/^#/, '') || '/').split('?')[0]!;
  for (const [re, page, names] of TABLE) {
    const m = re.exec(path);
    if (m) return { page, params: Object.fromEntries(names.map((n, i) => [n, m[i + 1]!])) };
  }
  return { page: 'notFound', params: {} };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setRoute(parse(window.location.hash)); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
export const go = (path: string) => { window.location.hash = path; };
