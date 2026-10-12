// Web shell (evolution of the Grant OS shell: module navigation, user context, page code footer) in direction A "clinical glass".
import type { ReactNode } from 'react';

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
    <span>Page <span className="t-mono" data-page-code={pageCode}>{pageCode}</span></span></footer>;
}
