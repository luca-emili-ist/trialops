// TRO-090 Sign in. Deployed: email + password through the Platform API (lockout, CMP-03), then the authenticator:
// TRO-091 code of the authenticator app, TRO-092 enrolment of a first authenticator (IAM-01, MFA mandatory).
// Local development: demo user switch (DEMO-02). Site-facing: localised in English and Japanese (NFR-07).
import { useState } from 'react';
import { Button, TextField, Panel, PageFooter, DataTable, Loading, ErrorNote, DefinitionList, LanguageSelect, useT } from '@trialops/shell';
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
  const t = useT();
  const step = s.mfaStep;
  const code = step?.kind === 'challenge' ? PAGE_CODES.loginMfa : step?.kind === 'enrol' ? PAGE_CODES.loginMfaEnrol : PAGE_CODES.login;
  return (
    <div className="shell-main">
      <div className="shell-banner" role="note">{t('Synthetic data — demonstration environment')}</div>
      <main className="shell-content signin" id="main" tabIndex={-1}>
        <div className="signin-tools"><LanguageSelect id="signin-language" /></div>
        <header className="page-header"><div><div className="signin-mark" aria-hidden="true" /><div className="crumbs">InSilicoTrials</div><h1>{t('Sign in to TrialOps')}</h1>
          <p>{t('Clinical operations platform for adaptive platform trials.')}</p></div></header>
        {s.notice && !step ? <Panel title={t('Session ended')}><p role="status">{s.notice}</p></Panel> : null}
        {step?.kind === 'challenge' ? <TotpChallenge /> : step?.kind === 'enrol' ? <TotpEnrol qr={step.qr} secret={step.secret} />
          : s.mode === 'dev' ? <DevUsers /> : <><PasswordForm /><DemoAccounts /></>}
      </main>
      <PageFooter pageCode={code} />
    </div>
  );
}

/** Six-digit code form shared by the challenge and the enrolment. */
function CodeForm({ label, hint, submitLabel }: { label: string; hint: string; submitLabel: string }) {
  const s = useSession();
  const t = useT();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="stack" onSubmit={e => {
      e.preventDefault(); setError(null); setBusy(true);
      s.verifyMfa(code).then(back, err => { setError((err as Error).message); setBusy(false); setCode(''); });
    }}>
      <TextField label={label} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus
        onChange={e => setCode(e.target.value.replace(/\D/g, ''))} hint={hint} error={error ?? undefined} />
      <div className="row">
        <Button variant="primary" type="submit" disabled={!/^\d{6}$/.test(code) || busy}>{busy ? t('Checking…') : submitLabel}</Button>
        <Button variant="ghost" type="button" onClick={() => { void s.signOut(); }}>{t('Use another account')}</Button>
      </div>
    </form>
  );
}

/** TRO-091: the second factor of the sign-in (IAM-01). */
function TotpChallenge() {
  const t = useT();
  return (
    <Panel title={t('Authenticator code')} meta={t('Multi-factor authentication is required for every role with GxP impact.')}>
      <CodeForm label={t('Code from your authenticator app')} hint={t('6 digits; the code changes every 30 seconds')} submitLabel={t('Verify and continue')} />
    </Panel>
  );
}

/** TRO-092: enrolment of a first authenticator (TOTP), mandatory before the platform opens (IAM-01). */
function TotpEnrol({ qr, secret }: { qr: string; secret: string }) {
  const t = useT();
  return (
    <Panel title={t('Set up your authenticator')} meta={t('TrialOps requires multi-factor authentication. Use an authenticator app (for example Microsoft Authenticator, Google Authenticator or 1Password) on a device you keep with you.')}>
      <div className="stack">
        <ol className="stack">
          <li>{t('Scan this QR code with the authenticator app.')}</li>
          <li>{t('If you cannot scan it, add the account by hand with the setup key below.')}</li>
          <li>{t('Enter the 6-digit code the app shows to finish.')}</li>
        </ol>
        <img src={qr} width={180} height={180} alt={t('QR code to add TrialOps to your authenticator app')} />
        <DefinitionList items={[[t('Setup key'), <span className="t-mono" key="k">{secret}</span>], [t('Account'), 'TrialOps']]} />
        <CodeForm label={t('Code from your authenticator app')} hint={t('Proves that the app is set up; the authenticator is then active')} submitLabel={t('Activate and continue')} />
      </div>
    </Panel>
  );
}

function PasswordForm() {
  const s = useSession();
  const t = useT();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel title={t('Account')}>
      <form className="stack" onSubmit={e => { e.preventDefault(); setError(null); s.signIn(email, password).then(back, err => setError((err as Error).message)); }}>
        <TextField label={t('Email')} type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
        <TextField label={t('Password')} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} error={error ?? undefined} />
        <div><Button variant="primary" type="submit" disabled={!email || !password}>{t('Sign in')}</Button></div>
      </form>
    </Panel>
  );
}

function DevUsers() {
  const s = useSession();
  const t = useT();
  const users = useData<{ items: DemoUser[] }>('/v1/dev/users');
  return (
    <Panel title={t('Demo users')} meta={t('Local demonstration: choose a role to see what it can see and do. Signatures use the password demo-password.')}>
      {users.error ? <ErrorNote error={`${users.error}. ${t('Start the API with npm run dev:api.')}`} /> : !users.data ? <Loading /> :
        <DataTable rows={users.data.items} rowKey={u => u.sub} onRowClick={u => { void s.signIn(u.sub).then(back); }} label={t('Demo users')} columns={[
          { key: 'full_name', label: t('Person') }, { key: 'org', label: t('Organization') },
          { key: 'roles', label: t('Role'), render: u => u.roles.split(', ').map(r => t(r.replace(/_/g, ' '))).join(', ') || '—' },
          { key: 'go', label: t('Action'), render: u => <Button variant="secondary" aria-label={t('Sign in as {name}', { name: u.full_name })}
            onClick={e => { e.stopPropagation(); void s.signIn(u.sub).then(back); }}>{t('Sign in')}</Button> },
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
  const t = useT();
  return (
    <Panel title={t('Demonstration accounts')} meta={t('Synthetic people of the demo platform. Ask the platform owner for the demonstration password.')}>
      <DataTable rows={DEMO_ACCOUNTS.map(([role, k]) => ({ role: t(role), email: `${k}@demo.trialops.example` }))} rowKey={r => r.email} label={t('Demonstration accounts')}
        columns={[{ key: 'role', label: t('Role') }, { key: 'email', label: t('Email'), render: r => <span className="t-mono">{r.email}</span> }]} />
    </Panel>
  );
}
