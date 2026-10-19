// NFR-07: site- and subject-facing pages in English and Japanese; dates shown with their time zone (rule 11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate, pickLocale, formatDateTime, formatDate, mergeCatalogues } from '../../../packages/shell/src/i18n-core.ts';
import { SHELL_JA } from '../../../packages/shell/src/i18n/ja.ts';
import { WEB_JA } from '../src/i18n/ja.ts';
import { SITE_FACING_PAGES } from '../src/i18n/pages.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
const shell = join(src, '../../../packages/shell/src');
const ja = mergeCatalogues({ ja: SHELL_JA }, { ja: WEB_JA }).ja!;   // as apps/web/src/i18n/index.ts merges them
// labels that reach t() through a variable, read from the source (App.tsx and format.ts need the browser to be imported)
const app = readFileSync(join(src, 'App.tsx'), 'utf8');
const NAV_TEXTS = [...app.matchAll(/\{ label: '([^']+)', href: '[^']+', pages: \[[^\]]*\], group: '([^']+)'/g)].flatMap(m => [m[1]!, m[2]!]);
const METRIC_TEXTS = [...readFileSync(join(src, 'format.ts'), 'utf8').split('export const METRIC_LABEL')[1]!.matchAll(/(?:final_met|interim_met|off_target|no_data): '([^']+)'/g)].map(m => m[1]!);

/** Literal keys of t('...') / tr('...') / tr.current('...') calls in a source file. */
function keysOf(code: string): string[] {
  const out: string[] = [];
  const re = /\b(?:t|tr|tr\.current)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  for (const m of code.matchAll(re)) out.push(m[2]!.replace(/\\(['"\\])/g, '$1'));
  return out;
}
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('[NFR-07] every text of the site-facing pages and of the shell has a Japanese translation with the same variables', () => {
  const files = [...SITE_FACING_PAGES.map(f => join(src, f)), join(shell, 'AppShell.tsx'), join(shell, 'i18n.tsx'),
    ...readdirSync(join(shell, 'ui')).filter(f => f.endsWith('.tsx')).map(f => join(shell, 'ui', f))];
  const missing: string[] = [];
  let n = 0;
  for (const f of files) for (const k of keysOf(readFileSync(f, 'utf8'))) { n++; if (!ja[k]) missing.push(`${f.split('/src/').pop()}: ${k}`); }
  assert.deepEqual(missing, [], `texts without Japanese:\n${missing.join('\n')}`);
  assert.ok(n > 250, `the scan finds the texts (${n})`);
  // texts that reach t() through a variable: navigation, activation steps, metric states, constants of the shell
  assert.ok(NAV_TEXTS.length >= 16 && METRIC_TEXTS.length === 4, 'navigation and metric labels found');
  for (const k of [...NAV_TEXTS, ...METRIC_TEXTS, 'Qualification', 'Contract', 'IRB', 'Training', 'Green light',
    'Copy the link to this page', 'link copied', 'Change', 'Bug', 'New feature', 'review', 'approval']) assert.ok(ja[k], `no Japanese for "${k}"`);
  for (const [k, v] of Object.entries(ja)) {
    assert.ok(v.trim(), `empty translation for "${k}"`);
    assert.deepEqual(vars(v), vars(k), `variables differ in "${k}"`);
  }
});

test('[NFR-07] the Japanese catalogues say they are machine-drafted and need a native speaker review', () => {
  for (const f of [join(src, 'i18n/ja.ts'), join(shell, 'i18n/ja.ts')]) {
    assert.match(readFileSync(f, 'utf8').split('\n').slice(0, 6).join('\n'), /MACHINE-DRAFTED[\s\S]*NEEDS REVIEW BY A NATIVE JAPANESE SPEAKER/, f);
  }
});

test('[NFR-07] locale from the person\'s choice, else the browser, else English; missing texts fall back to English', () => {
  assert.equal(pickLocale(null, []), 'en');
  assert.equal(pickLocale(null, ['ja-JP', 'en-US']), 'ja');
  assert.equal(pickLocale(null, ['fr-FR', 'en-GB']), 'en');
  assert.equal(pickLocale(null, ['fr-FR']), 'en');
  assert.equal(pickLocale('en', ['ja-JP']), 'en', 'a stored choice wins over the browser');
  assert.equal(pickLocale('xx', ['ja']), 'ja', 'an unknown stored value is ignored');
  assert.equal(translate(ja, 'Tasks'), 'タスク');
  assert.equal(translate(ja, 'Not in the catalogue {n}', { n: 3 }), 'Not in the catalogue 3');
  assert.equal(translate(ja, '{n} awaiting review', { n: 2 }), 'レビュー待ち 2');
  assert.deepEqual(mergeCatalogues({ ja: { a: '1' } }, { ja: { b: '2' } }), { ja: { a: '1', b: '2' } });
});

test('[NFR-07] dates and times are shown in the locale with the time zone; the server keeps UTC (rule 11)', () => {
  const iso = '2026-10-19T07:05:00Z';
  assert.match(formatDateTime(iso, 'en'), /2026.*(UTC|GMT|[A-Z]{2,4}|[+-]\d)/);
  assert.match(formatDateTime(iso, 'ja'), /2026年10月19日.*(UTC|GMT|JST|[+-]\d)/);
  assert.match(formatDate(iso, 'ja'), /2026年10月19日/);
  assert.equal(formatDateTime(null, 'ja'), '—');
  const fmt = readFileSync(join(src, 'format.ts'), 'utf8');
  assert.match(fmt, /formatDateTime\(v\)/, 'the pages format through the shell (locale + time zone)');
  assert.doesNotMatch(readFileSync(join(shell, 'i18n-core.ts'), 'utf8').match(/export function formatDateTime[\s\S]*?\n}/)![0], /timeZone: /,
    'shown in the time zone of the reader, labelled; never a fixed zone');
});
