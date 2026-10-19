// Web shell (evolution of the Grant OS shell: module navigation, user context, page code footer) in direction A "clinical glass".
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from './i18n.tsx';

/** `count`: items waiting in that area, `severity` colours it only when something is wrong (P11, peripheral layer by severity). */
export interface NavItem { label: string; href: string; active?: boolean; group?: string; count?: number; severity?: 'neutral' | 'warn' | 'bad' }

/** `actions`: controls at the top right of every page (e.g. Suggest changes, UX-01). */
export function AppShell({ brand, subtitle, nav, user, banner, actions, pageCode, children }: {
  brand: string; subtitle?: string; nav: NavItem[]; user?: ReactNode; banner?: ReactNode; actions?: ReactNode; pageCode: string; children: ReactNode;
}) {
  const t = useT();
  let lastGroup: string | undefined;
  return (
    <div className="shell">
      <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus(); }}>{t('Skip to content')}</a>
      <nav className="shell-nav" aria-label={t('Main')}>
        <div className="shell-brand">{brand}{subtitle ? <small>{subtitle}</small> : null}</div>
        {nav.flatMap(n => {
          const out: ReactNode[] = [];
          if (n.group && n.group !== lastGroup) out.push(<div className="nav-group" key={`g-${n.group}`}>{n.group}</div>);
          lastGroup = n.group;
          out.push(<a key={n.href} href={n.href} aria-current={n.active ? 'page' : undefined}><span>{n.label}</span>
            {n.count ? <span className="nav-count" data-severity={n.severity ?? 'neutral'}>{n.count}<span className="sr-only"> {t('waiting')}</span></span> : null}</a>);
          return out;
        })}
        {user ? <div className="shell-user">{user}</div> : null}
      </nav>
      <div className="shell-main">
        {banner || actions ? <div className="shell-top">{banner ? <div className="shell-banner">{banner}</div> : <span />}
          {actions ? <div className="shell-actions no-print">{actions}</div> : null}</div> : null}
        <main className="shell-content" id="main" tabIndex={-1}>{children}</main>
        <PageFooter pageCode={pageCode} />
      </div>
    </div>
  );
}

/** Copyright and stable page code on every screen (house rule §19). */
export function PageFooter({ pageCode }: { pageCode: string }) {
  const t = useT();
  return <footer className="shell-footer"><span>© {new Date().getFullYear()} InSilicoTrials Technologies · TrialOps · AGPL-3.0</span>
    <span>{t('Page')} <PageCodeBadge code={pageCode} /></span></footer>;
}

const COPY_LINK_LABEL = 'Copy the link to this page';
const LINK_COPIED_LABEL = 'link copied';

/** The page code is a button: a click copies the direct link to this page (the hash route is in the address bar),
 *  so a screen can be sent to someone without knowing which menu item it is. Same behaviour as GosPageCodeBadge in Grant OS. */
export function PageCodeBadge({ code }: { code: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(id);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch (e) {
      console.warn('Copy link failed', e);
    }
  };
  // the accessible name starts with the visible code (WCAG 2.5.3 label in name)
  return <button type="button" className="page-code t-mono" data-page-code={code} onClick={copy} title={t(COPY_LINK_LABEL)} aria-label={`${code} — ${t(COPY_LINK_LABEL)}`}>
    {code}{copied ? <span className="page-code-copied" role="status"> · {t(LINK_COPIED_LABEL)}</span> : null}</button>;
}
