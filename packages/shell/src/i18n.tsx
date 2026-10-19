// React side of the localisation (NFR-07): provider, hooks and the language switch. Logic in ./i18n-core.ts.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatDate, formatDateTime, LOCALE_STORE_KEY, LOCALES, pickLocale, setCurrentLocale, translate, type Catalogues, type Locale, type Vars } from './i18n-core.ts';

export * from './i18n-core.ts';

export interface I18n {
  locale: Locale;
  setLocale(l: Locale): void;
  t(text: string, vars?: Vars): string;
  fmtDate(v: string | null | undefined): string;
  fmtDateTime(v: string | null | undefined): string;
}

const english: I18n = { locale: 'en', setLocale: () => undefined, t: (text, vars) => translate(undefined, text, vars),
  fmtDate: v => formatDate(v, 'en'), fmtDateTime: v => formatDateTime(v, 'en') };
const Ctx = createContext<I18n>(english);

function storedLocale(): string | null { try { return localStorage.getItem(LOCALE_STORE_KEY); } catch { return null; } }
function browserLanguages(): readonly string[] { return typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]; }

export function I18nProvider({ catalogues, children, initial }: { catalogues: Catalogues; children: ReactNode; initial?: Locale }) {
  const [locale, setState] = useState<Locale>(() => initial ?? pickLocale(storedLocale(), browserLanguages()));
  setCurrentLocale(locale);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);   // WCAG 3.1.1 language of the page
  const setLocale = useCallback((l: Locale) => {
    try { localStorage.setItem(LOCALE_STORE_KEY, l); } catch { /* storage blocked: the choice lasts for this page */ }
    setState(l);
  }, []);
  const value = useMemo<I18n>(() => ({ locale, setLocale, t: (text, vars) => translate(catalogues[locale], text, vars),
    fmtDate: v => formatDate(v, locale), fmtDateTime: v => formatDateTime(v, locale) }), [locale, setLocale, catalogues]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = (): I18n => useContext(Ctx);
/** Shorthand for components that only translate. */
export const useT = (): I18n['t'] => useContext(Ctx).t;

/** Language switch (a labelled select), for the user area of the shell and the sign-in page. */
export function LanguageSelect({ id = 'trialops-language' }: { id?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <span className="lang-select">
      <label htmlFor={id}>{t('Language')}</label>
      <select id={id} className="select" value={locale} onChange={e => setLocale(e.target.value as Locale)}>
        {LOCALES.map(l => <option key={l.value} value={l.value} lang={l.value}>{l.label}</option>)}
      </select>
    </span>
  );
}
