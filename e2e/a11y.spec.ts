// NFR-07: automated accessibility check (axe-core, WCAG 2.1 A/AA rules) of every route of the web app, in English and
// Japanese, at 1440 px and 375 px, plus the layout rule of docs/DESIGN.md (no horizontal page scroll at either width).
// Read-only: it signs in as the synthetic platform admin (sees every page) and opens each page; nothing is written.
// Screenshots and the JSON summary go to e2e/screens/a11y (not versioned). Run: npm run e2e -- a11y
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './ports.ts';

const OUT = join(import.meta.dirname, 'screens', 'a11y');
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 375, height: 812 }] as const;
const LOCALES = ['en', 'ja'] as const;

interface Finding { route: string; locale: string; viewport: string; violations: { id: string; impact: string | null; nodes: number; help: string; targets: string[] }[];
  horizontalScroll: number; lang: string }

async function devToken(request: APIRequestContext, sub: string): Promise<string> {
  const r = await request.post(`${E2E.apiUrl}/v1/dev/login`, { data: { sub } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).access_token as string;
}

/** Every route of apps/web/src/router.ts, with ids of the synthetic seed for the parameterised ones. */
async function routes(request: APIRequestContext, token: string): Promise<string[]> {
  const h = { authorization: `Bearer ${token}` };
  const get = async (p: string) => (await request.get(`${E2E.apiUrl}${p}`, { headers: h })).json();
  const plat = (await get('/v1/platforms')).items[0].id as string;
  const arm = (await get(`/v1/platforms/${plat}/arms`)).items[0];
  const armDetail = await get(`/v1/arms/${arm.id}`);
  const site = (await get(`/v1/platforms/${plat}/sites`)).items[0].id as string;
  const task = (await get(`/v1/platforms/${plat}/tasks?mine=false&state=all`)).items[0].id as string;
  const appendix = armDetail.appendix_versions?.[0]?.id as string | undefined;
  return ['/', '/arms', '/arms/new', `/arms/${arm.id}`, ...(appendix ? [`/protocol/appendix/${appendix}`] : []), '/sites', `/sites/${site}`, '/tasks',
    `/tasks/${task}`, '/apps', '/ai', '/ai/monitoring', '/ai/pending', '/audit', '/change-requests', '/quality', '/providers', '/privacy',
    '/app-validation', '/ui', '/nope-not-a-page'];
}

/** Waits until the page has loaded its data (no loading line left), or 10 s. */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(e => /…$/.test(e.textContent ?? '')), undefined, { timeout: 10_000 })
    .catch(() => undefined);
}

async function check(page: Page, route: string, locale: string, viewport: string): Promise<Finding> {
  await settled(page);
  const axe = await new AxeBuilder({ page }).withTags(WCAG).exclude('[data-suggest-ui] .suggest-layer').analyze();
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const lang = await page.evaluate(() => document.documentElement.lang);
  const name = `${viewport}-${locale}-${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'overview'}`;
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  return { route, locale, viewport, lang, horizontalScroll: scroll,
    violations: axe.violations.map(v => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 5).map(n => n.target.join(' ')) })) };
}

test.describe.configure({ mode: 'serial' });

test('[NFR-07] every route passes the WCAG 2.1 AA rules of axe and has no horizontal scroll, in English and Japanese, at 1440 and 375 px', async ({ browser, request }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const token = await devToken(request, 'demo|admin');
  const all = await routes(request, token);
  const findings: Finding[] = [];
  for (const vp of VIEWPORTS) for (const locale of LOCALES) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: locale === 'ja' ? 'ja-JP' : 'en-US' });
    // signed out first: the sign-in page (TRO-090) in this locale
    const login = await context.newPage();
    await login.addInitScript(l => { try { localStorage.setItem('trialops.locale', l); } catch { /* ignore */ } }, locale);
    await login.goto(`${E2E.webUrl}/#/login`);
    findings.push(await check(login, '/login', locale, vp.name));
    await login.close();
    const page = await context.newPage();
    await page.addInitScript(([t, l]) => { sessionStorage.setItem('trialops.dev.token', t!); localStorage.setItem('trialops.locale', l!); }, [token, locale]);
    for (const r of all) {
      await page.goto(`${E2E.webUrl}/#${r}`);
      await expect(page.locator('footer [data-page-code]')).toBeVisible();
      findings.push(await check(page, r, locale, vp.name));
    }
    await context.close();
  }
  const violations = findings.flatMap(f => f.violations.map(v => `${f.viewport} ${f.locale} ${f.route}: ${v.id} (${v.impact}, ${v.nodes}) ${v.targets.join(' | ')}`));
  const scrolls = findings.filter(f => f.horizontalScroll > 0).map(f => `${f.viewport} ${f.locale} ${f.route}: +${f.horizontalScroll}px`);
  const wrongLang = findings.filter(f => f.lang !== f.locale).map(f => `${f.viewport} ${f.locale} ${f.route}: lang=${f.lang}`);
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), tags: WCAG, pages: findings.length, routes: all.length + 1,
    violations: violations.length, horizontal_scroll: scrolls, wrong_lang: wrongLang, findings }, null, 2));
  expect(violations, violations.join('\n')).toEqual([]);
  expect(scrolls, scrolls.join('\n')).toEqual([]);
  expect(wrongLang, wrongLang.join('\n')).toEqual([]);
});
