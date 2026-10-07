// TRO-090 Sign in. Deployed: Supabase Auth (email + password). Local development: demo user switch (DEMO-02).
import { useState } from 'react';
import { Button, TextField, Panel, PageFooter, DataTable, Loading, ErrorNote } from '@trialops/shell';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { PAGE_CODES } from '../pageCodes.ts';

interface DemoUser { sub: string; full_name: string; org: string; roles: string }

function back() {
  let to: string | null = null;
  try { to = sessionStorage.getItem('trialops.return'); sessionStorage.removeItem('trialops.return'); } catch { /* storage blocked */ }
  if (to && !to.includes('#/login')) window.location.assign(to); else go('/');
}

export function Login() {
  const s = useSession();
  return (
    <div className="shell-main">
      <div className="shell-banner">Synthetic data — demonstration environment</div>
      <main className="shell-content" id="main">
        <header className="page-header"><div><div className="crumbs">InSilicoTrials</div><h1>Sign in to TrialOps</h1>
          <p>Clinical operations platform for adaptive platform trials.</p></div></header>
        {s.mode === 'dev' ? <DevUsers /> : <><PasswordForm /><DemoAccounts /></>}
      </main>
      <PageFooter pageCode={PAGE_CODES.login} />
    </div>
  );
}

function PasswordForm() {
  const s = useSession();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel title="Account">
      <form className="stack" onSubmit={e => { e.preventDefault(); setError(null); s.signIn(email, password).then(back, err => setError((err as Error).message)); }}>
        <TextField label="Email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
        <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} error={error ?? undefined} />
        <div><Button variant="primary" type="submit" disabled={!email || !password}>Sign in</Button></div>
      </form>
    </Panel>
  );
}

function DevUsers() {
  const s = useSession();
  const users = useData<{ items: DemoUser[] }>('/v1/dev/users');
  return (
    <Panel title="Demo users" meta="Local demonstration: choose a role to see what it can see and do. Signatures use the password demo-password.">
      {users.error ? <ErrorNote error={`${users.error}. Start the API with npm run dev:api.`} /> : !users.data ? <Loading /> :
        <DataTable rows={users.data.items} rowKey={u => u.sub} onRowClick={u => { void s.signIn(u.sub).then(back); }} columns={[
          { key: 'full_name', label: 'Person' }, { key: 'org', label: 'Organization' },
          { key: 'roles', label: 'Role', render: u => u.roles.replace(/_/g, ' ') || '—' },
          { key: 'go', label: '', render: u => <Button variant="secondary" onClick={e => { e.stopPropagation(); void s.signIn(u.sub).then(back); }}>Sign in</Button> },
        ]} />}
    </Panel>
  );
}

const DEMO_ACCOUNTS: [string, string][] = [
  ['Platform admin', 'admin'], ['Platform operations manager', 'ops'], ['Regulatory lead', 'reg'], ['Clinical trial manager', 'ctm'],
  ['CRA', 'cra'], ['Sponsor of ARM-A (Arden Therapeutics)', 'arden'], ['Site PI, site 101', 'pi101'], ['QA / auditor', 'qa'],
  ['SAC member (unblinded)', 'sac'], ['Data manager', 'dm'], ['Safety physician', 'safety'], ['Finance controller', 'fin'],
];
/** Synthetic demo accounts (DEMO-02): one per role, to show what each role can see. The password is shared out of band. */
function DemoAccounts() {
  return (
    <Panel title="Demonstration accounts" meta="Synthetic people of the demo platform. Ask the platform owner for the demonstration password.">
      <DataTable rows={DEMO_ACCOUNTS.map(([role, k]) => ({ role, email: `${k}@demo.trialops.example` }))} rowKey={r => r.email}
        columns={[{ key: 'role', label: 'Role' }, { key: 'email', label: 'Email', render: r => <span className="t-mono">{r.email}</span> }]} />
    </Panel>
  );
}
