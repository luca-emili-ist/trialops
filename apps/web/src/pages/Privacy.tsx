// TRO-056 Privacy (CMP-08, GDPR art. 25/30/32/44, HIPAA §164.312, APPI; NFR-06): the privacy self-check of the platform
// with failed checks first (P3) and their detail (P6), the region where the platform data stays and the region served by
// this deployment, and the record of processing activities (ROPA) as approved versions with who approved them (P5).
// Readers: platform admins and QA auditors (the self-check is refused to other roles by the API). English only.
import { useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Loading, ErrorNote, EmptyState, AttentionList, DefinitionList, SelectField } from '@trialops/shell';
import { useData, useSession } from '../session.tsx';
import { fmtDateTime, human } from '../format.ts';

export const PRIVACY_ROLES = ['platform_admin', 'qa_auditor'] as const;

interface Check { check_code: string; subject: string; ok: boolean; detail: string }
interface Ropa { id: string; code: string; version: number; title: string; controller: string; purpose: string; legal_basis_eu: string | null; legal_basis_us: string | null;
  legal_basis_jp: string | null; data_subject_categories: string[]; data_categories: string[]; recipients: string[]; regions: string[]; transfers: string;
  retention: string; security_measures: string; status: string; approved_by: string | null; approved_at: string | null; created_by: string; created_at: string }
interface Region { deployment_region: string | null; database_region: string | null; pinned: boolean; ok: boolean; problem: string | null;
  platforms: { id: string; code: string; data_region: string | null }[] }

export function Privacy() {
  const s = useSession();
  const allowed = s.can(...PRIVACY_ROLES);
  const pid = s.platform?.id;
  const [all, setAll] = useState('false');
  const check = useData<{ ok: boolean; items: Check[] }>(allowed && pid ? `/v1/privacy/check?platform_id=${pid}` : null);
  const ropa = useData<{ items: Ropa[] }>(allowed ? `/v1/privacy/ropa?all=${all}` : null);
  const region = useData<Region>(allowed ? '/v1/region' : null);
  if (!allowed) return <EmptyState title="Privacy records are read by platform administrators and QA auditors" />;
  const failed = (check.data?.items ?? []).filter(c => !c.ok);
  const mine = region.data?.platforms.find(p => p.id === pid);
  return (
    <>
      <PageHeader title="Privacy" subtitle="Privacy by design for the platform: pseudonymous subject codes in the core, re-identification only in the SAC enclave, data kept in its region, agreements with every provider, and the record of processing activities."
        facts={[['Data region of the platform', mine?.data_region ?? '—'], ['Region of this deployment', region.data?.deployment_region ?? 'not pinned'],
          ['Self-check', check.data ? (check.data.ok ? 'passed' : `${failed.length} failed`) : '—']]} />
      <Panel title="Privacy self-check" meta="Run by the database on the records of this platform each time the page opens.">
        {check.error ? <ErrorNote error={check.error} /> : !check.data ? <Loading what="Running the privacy self-check" /> : <>
          <AttentionList clear="Every privacy check passes on this platform." items={failed.map(c => ({ key: `${c.check_code}-${c.subject}`, severity: 'bad' as const,
            title: `${human(c.check_code.replace('.', ': '))} · ${c.subject}`, reason: c.detail }))} />
          <DataTable rows={check.data.items} rowKey={c => `${c.check_code}-${c.subject}`} label="Privacy checks" columns={[
            { key: 'check_code', label: 'Check', render: c => <span className="t-mono">{c.check_code}</span> },
            { key: 'subject', label: 'On' },
            { key: 'ok', label: 'Result', render: c => c.ok ? 'Passed' : <StatusPill tone="bad">Failed</StatusPill>, sortValue: c => (c.ok ? 1 : 0) },
            { key: 'detail', label: 'Detail', wrap: true },
          ]} /></>}
      </Panel>
      <Panel title="Data residency (NFR-06)">
        {region.error ? <ErrorNote error={region.error} /> : !region.data ? <Loading /> :
          <DefinitionList items={[
            ['This deployment serves', region.data.deployment_region ?? 'every region (not pinned: development, tests or the transitional demo)'],
            ['Region of the database', region.data.database_region ?? 'not declared'],
            ['Configuration', region.data.ok ? 'consistent' : <StatusPill tone="bad">{region.data.problem}</StatusPill>],
            ['Platforms you can see here', region.data.platforms.map(p => `${p.code} (${p.data_region ?? 'no region'})`).join(', ') || '—'],
          ]} />}
      </Panel>
      <Panel title="Record of processing activities" actions={<SelectField label="Versions" value={all} onChange={e => setAll(e.target.value)}
        options={[{ value: 'false', label: 'Current (approved and drafts)' }, { value: 'true', label: 'Every version' }]} />}
        meta="GDPR art. 30. A new version is drafted and approved by someone other than its author; approved versions never change.">
        {ropa.error ? <ErrorNote error={ropa.error} /> : !ropa.data ? <Loading /> :
          <DataTable rows={ropa.data.items} rowKey={r => r.id} label="Record of processing activities" empty={<EmptyState title="No processing activity recorded" />} columns={[
            { key: 'code', label: 'Entry', render: r => <span className="cell-stack"><span className="t-mono">{r.code} v{r.version}</span><small>{human(r.status)}</small></span>,
              sortValue: r => `${r.code}-${String(r.version).padStart(4, '0')}` },
            { key: 'title', label: 'Processing', wrap: true, render: r => <span className="cell-stack"><span>{r.title}</span><small>{r.purpose}</small></span> },
            { key: 'basis', label: 'Legal basis per region', wrap: true, render: r => <span className="cell-stack">
              {r.legal_basis_eu ? <small>EU: {r.legal_basis_eu}</small> : null}{r.legal_basis_us ? <small>US: {r.legal_basis_us}</small> : null}
              {r.legal_basis_jp ? <small>JP: {r.legal_basis_jp}</small> : null}</span> },
            { key: 'data', label: 'Data and recipients', wrap: true, render: r => <span className="cell-stack"><span>{r.data_categories.map(human).join(', ')}</span>
              <small>{r.recipients.join(', ') || 'no recipient'} · {r.regions.join(', ')} · transfers: {r.transfers}</small></span> },
            { key: 'retention', label: 'Retention', wrap: true },
            { key: 'approved', label: 'Approved', render: r => r.approved_by ? <span className="cell-stack"><span>{r.approved_by}</span><small>{fmtDateTime(r.approved_at)}</small></span> : '—' },
          ]} />}
      </Panel>
    </>
  );
}
