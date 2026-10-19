// Localisation (NFR-07, rule 15): English is the source language and the default; site- and subject-facing pages are also
// in Japanese. Deliberately small:
//   * the key of a message is its English text: `t('Assigned to')`; variables in braces: `t('{n} waiting', { n })`;
//   * a catalogue maps the English text to the translation; a missing entry falls back to English (never a key);
//   * the locale comes from the person's choice (stored in this browser), else the browser languages, else English;
//   * dates and times are formatted for the locale and always show the time zone (rule 11: the server keeps UTC).
// Catalogues of the shell live in ./i18n/; the app merges its own (apps/web/src/i18n/) with mergeCatalogues.
// This module has no JSX, so node tests import it directly; the React part is in ./i18n.tsx.

export type Locale = 'en' | 'ja';
export const LOCALES: { value: Locale; label: string }[] = [{ value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }];
/** English source text -> translation. */
export type Catalogue = Record<string, string>;
export type Catalogues = Partial<Record<Locale, Catalogue>>;
export type Vars = Record<string, string | number>;

export const LOCALE_STORE_KEY = 'trialops.locale';
const BCP47: Record<Locale, string> = { en: 'en-US', ja: 'ja-JP' };

/** Merges catalogue bundles; later bundles win. */
export function mergeCatalogues(...bundles: Catalogues[]): Catalogues {
  const out: Catalogues = {};
  for (const b of bundles) for (const [l, c] of Object.entries(b) as [Locale, Catalogue][]) out[l] = { ...(out[l] ?? {}), ...c };
  return out;
}

/** Translation of an English text, with {name} variables replaced; English when the catalogue has no entry. */
export function translate(catalogue: Catalogue | undefined, text: string, vars?: Vars): string {
  const s = catalogue?.[text] ?? text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** The person's stored choice, else the first supported browser language, else English. */
export function pickLocale(stored: string | null | undefined, browser: readonly string[] = []): Locale {
  if (stored === 'en' || stored === 'ja') return stored;
  for (const l of browser) {
    const base = l.toLowerCase().split('-')[0];
    if (base === 'ja') return 'ja';
    if (base === 'en') return 'en';
  }
  return 'en';
}

let current: Locale = 'en';
/** Locale in force, for plain formatting helpers outside React components. */
export const currentLocale = (): Locale => current;
/** Set by the provider of the shell when the locale changes. */
export const setCurrentLocale = (l: Locale): void => { current = l; };

/** Date for the locale (no time: no time zone needed). */
export function formatDate(v: string | null | undefined, locale: Locale = current): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString(BCP47[locale], { year: 'numeric', month: 'short', day: 'numeric' });
}
/** Date and time for the locale, always with the time zone shown (rule 11). */
export function formatDateTime(v: string | null | undefined, locale: Locale = current): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(BCP47[locale], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit',
    minute: '2-digit', timeZoneName: 'short' });
}

