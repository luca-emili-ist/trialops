// Web shell (evolution of the Grant OS shell: module navigation, user context, page code footer) in direction A "clinical glass".
import { useEffect, useState, type ReactNode } from 'react';

/** `count`: items waiting in that area, `severity` colours it only when something is wrong (P11, peripheral layer by severity). */
export interface NavItem { label: string; href: string; active?: boolean; group?: string; count?: number; severity?: 'neutral' | 'warn' | 'bad' }

/** `actions`: controls at the top right of every page (e.g. Suggest changes, UX-01). */
export function AppShell({ brand, subtitle, nav, user, banner, actions, pageCode, children }: {
  brand: string; subtitle?: string; nav: NavItem[]; user?: ReactNode; banner?: ReactNode; actions?: ReactNode; pageCode: string; children: ReactNode;
}) {
  let lastGroup: string | undefined;
  return (
    <div className="shell">
      <nav className="shell-nav" aria-label="Main">
        <div className="shell-brand">{brand}{subtitle ? <small>{subtitle}</small> : null}</div>
        {nav.flatMap(n => {
          const out: ReactNode[] = [];
          if (n.group && n.group !== lastGroup) out.push(<div className="nav-group" key={`g-${n.group}`}>{n.group}</div>);
          lastGroup = n.group;
          out.push(<a key={n.href} href={n.href} aria-current={n.active ? 'page' : undefined}><span>{n.label}</span>
            {n.count ? <span className="nav-count" data-severity={n.severity ?? 'neutral'} aria-label={`${n.count} waiting`}>{n.count}</span> : null}</a>);
          return out;
        })}
        {user ? <div className="shell-user">{user}</div> : null}
      </nav>
      <div className="shell-main">
        {banner || actions ? <div className="shell-top">{banner ? <div className="shell-banner">{banner}</div> : <span />}
          {actions ? <div className="shell-actions no-print">{actions}</div> : null}</div> : null}
        <main className="shell-content" id="main">{children}</main>
        <PageFooter pageCode={pageCode} />
      </div>
    </div>
  );
}

/** Copyright and stable page code on every screen (house rule §19). */
export function PageFooter({ pageCode }: { pageCode: string }) {
  return <footer className="shell-footer"><span>© {new Date().getFullYear()} InSilicoTrials Technologies · TrialOps · AGPL-3.0</span>
    <span>Page <PageCodeBadge code={pageCode} /></span></footer>;
}

const COPY_LINK_LABEL = 'Copy the link to this page';
const LINK_COPIED_LABEL = 'link copied';

/** The page code is a button: a click copies the direct link to this page (the hash route is in the address bar),
 *  so a screen can be sent to someone without knowing which menu item it is. Same behaviour as GosPageCodeBadge in Grant OS. */
export function PageCodeBadge({ code }: { code: string }) {
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
  return <button type="button" className="page-code t-mono" data-page-code={code} onClick={copy} title={COPY_LINK_LABEL} aria-label={`${COPY_LINK_LABEL} (${code})`}>
    {code}{copied ? <span className="page-code-copied"> · {LINK_COPIED_LABEL}</span> : null}</button>;
}
