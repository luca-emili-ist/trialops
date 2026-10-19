// TRO-041 Single sign-on hand-off: the signed-in user is sent here by an installed app; TrialOps issues a code and
// returns the user to the app without a new login (APP-ID-01).
import { useEffect, useRef, useState } from 'react';
import { PageHeader, Panel, ErrorNote, Loading, DefinitionList, useT } from '@trialops/shell';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';

export function OidcAuthorize() {
  const s = useSession();
  const t = useT();
  const q = new URLSearchParams(window.location.search);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);   // one code per hand-off, even when React runs the effect twice (StrictMode in development)
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    if (q.get('response_type') !== 'code') { setError('Unsupported request: response_type must be code.'); return; }
    api<{ redirect_to: string }>('POST', '/v1/oidc/authorize', { body: {
      client_id: q.get('client_id'), platform_id: q.get('platform_id') ?? s.platform?.id, redirect_uri: q.get('redirect_uri'),
      code_challenge: q.get('code_challenge'), code_challenge_method: q.get('code_challenge_method'),
      state: q.get('state') ?? undefined, nonce: q.get('nonce') ?? undefined, scope: q.get('scope') ?? undefined } })
      .then(r => window.location.assign(r.redirect_to), e => setError((e as Error).message));
  }, []);
  return (
    <>
      <PageHeader title={t('Signing you in')} subtitle={t('You are being returned to the application with your TrialOps identity.')} />
      <Panel>
        <DefinitionList items={[[t('Application'), q.get('client_id') ?? '—'], [t('Signed in as'), s.me?.person?.full_name ?? s.me?.sub ?? '—']]} />
        {error ? <ErrorNote error={error} /> : <Loading what={t('Redirecting')} />}
      </Panel>
    </>
  );
}
