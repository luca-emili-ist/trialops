import { useEffect, useRef } from 'react';
import { AppShell, Loading, Button, type NavItem } from '@trialops/shell';
import { useRoute, go } from './router.ts';
import { PAGE_CODES, type PageKey } from './pageCodes.ts';
import { useSession, useData } from './session.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Arms, ArmDetail } from './pages/Arms.tsx';
import { ArmWizard } from './pages/ArmWizard.tsx';
import { ProtocolEditor } from './pages/ProtocolEditor.tsx';
import { Sites, SiteDetail } from './pages/Sites.tsx';
import { Tasks, TaskDetail } from './pages/Tasks.tsx';
import { Apps } from './pages/Apps.tsx';
import { OidcAuthorize } from './pages/OidcAuthorize.tsx';
import { AiLedger } from './pages/AiLedger.tsx';
import { AuditTrail, AUDIT_ROLES } from './pages/AuditTrail.tsx';
import { Login } from './pages/Login.tsx';
import { UiCatalogue } from './pages/UiCatalogue.tsx';
import { NotFound } from './pages/NotFound.tsx';

/** `roles`: the item is shown only to these roles (the API and the database enforce the same rule). */
export const NAV: { label: string; href: string; pages: PageKey[]; group: string; roles?: readonly string[] }[] = [
  { label: 'Platform overview', href: '#/', pages: ['dashboard'], group: 'Platform' },
  { label: 'Arms & protocol', href: '#/arms', pages: ['arms', 'armDetail', 'armWizard', 'protocolEditor'], group: 'Platform' },
  { label: 'Site network', href: '#/sites', pages: ['sites', 'siteDetail'], group: 'Platform' },
  { label: 'Tasks', href: '#/tasks', pages: ['tasks', 'taskDetail'], group: 'Work' },
  { label: 'Applications', href: '#/apps', pages: ['apps'], group: 'Work' },
  { label: 'AI ledger', href: '#/ai', pages: ['aiLedger'], group: 'Trust' },
  { label: 'Audit trail', href: '#/audit', pages: ['auditTrail'], group: 'Trust', roles: AUDIT_ROLES },
];
const PUBLIC: PageKey[] = ['login', 'loginMfa', 'loginMfaEnrol', 'uiCatalogue'];

export function App() {
  const route = useRoute();
  const s = useSession();
  const needsLogin = !s.loading && !s.me && !PUBLIC.includes(route.page);
  useEffect(() => {
    if (needsLogin) {
      try { sessionStorage.setItem('trialops.return', window.location.href); } catch { /* storage blocked */ }
      go('/login');
    }
  }, [needsLogin]);

  // Peripheral layer (P11): what waits for me shows as a count beside Tasks, coloured only when a review waits.
  const inbox = useData<{ items: { state: string }[] }>(s.me && s.platform ? `/v1/platforms/${s.platform.id}/tasks?mine=true` : null);
  const reloadInbox = inbox.reload;
  const seenPage = useRef(route.page);
  useEffect(() => { if (seenPage.current !== route.page) { seenPage.current = route.page; reloadInbox(); } }, [route.page, reloadInbox]);
  const code = PAGE_CODES[route.page];
  if (s.loading) return <AppShell brand="TrialOps" nav={[]} pageCode={code}><Loading what="Signing in" /></AppShell>;
  if (route.page === 'login') return <Login />;
  if (route.page === 'uiCatalogue') return <UiCatalogue />;
  if (!s.me) return null;

  const p = route.params;
  const page = {
    dashboard: <Dashboard />, arms: <Arms />, armDetail: <ArmDetail id={p.id!} />, armWizard: <ArmWizard />,
    protocolEditor: <ProtocolEditor kind={p.kind as 'master' | 'appendix'} id={p.id!} />, sites: <Sites />, siteDetail: <SiteDetail id={p.id!} />,
    tasks: <Tasks />, taskDetail: <TaskDetail id={p.id!} />, apps: <Apps />, oidcAuthorize: <OidcAuthorize />, aiLedger: <AiLedger />, auditTrail: <AuditTrail />,
    notFound: <NotFound />, login: null, loginMfa: null, loginMfaEnrol: null, uiCatalogue: null,
  }[route.page];
  const waiting = inbox.data?.items.filter(t => t.state === 'waiting_review').length ?? 0;
  const nav: NavItem[] = NAV.filter(n => !n.roles || s.can(...n.roles)).map(n => ({ label: n.label, href: n.href, group: n.group, active: n.pages.includes(route.page),
    ...(n.href === '#/tasks' && inbox.data ? { count: inbox.data.items.length, severity: waiting ? 'warn' as const : 'neutral' as const } : {}) }));
  return (
    <AppShell brand="TrialOps" subtitle={s.platform ? `${s.platform.code} · ${s.platform.therapeutic_area}` : undefined} nav={nav}
      pageCode={code} banner="Synthetic data — demonstration environment"
      user={<>
        <span><strong>{s.me.person?.full_name ?? s.me.email ?? s.me.sub}</strong><br />{s.me.roles.map(r => r.replace(/_/g, ' ')).join(', ') || 'no role'}</span>
        <Button variant="ghost" onClick={() => { void s.signOut().then(() => go('/login')); }}>{s.mode === 'dev' ? 'Switch user' : 'Sign out'}</Button>
      </>}>
      {page}
    </AppShell>
  );
}
