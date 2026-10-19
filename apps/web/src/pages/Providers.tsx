// TRO-055 Service providers (CMP-05 oversight, CMP-08 agreements and residency, VAL-04 app suppliers): the registry with
// oversight status, the agreements of each provider and what is missing, and the providers this platform uses with the
// region their data stays in. Exceptions first (P3): overdue reviews, missing agreements, providers that may not receive
// the platform data now, each with its reason (P6). Read view; maintained through the API by platform admins and QA
// auditors. English only (platform administration).
import { useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, EmptyState, AttentionList, DefinitionList, type AttentionItem, type Tone } from '@trialops/shell';
import { useData, useSession } from '../session.tsx';
import { fmtDate, fmtDateTime, human, short } from '../format.ts';

export const PROVIDER_ROLES = ['platform_admin', 'qa_auditor'] as const;

interface ProviderRow { id: string; code: string; name: string; kind: string; status: string; data_categories: string[]; processing_regions: string[]; gxp_relevant: boolean;
  last_activity_on: string | null; last_outcome: string | null; next_review_due: string | null; overdue: boolean | null; agreement_gaps: number | null }
interface Agreement { id: string; kind: string; data_categories: string[]; regions: string[]; effective_from: string; expires_on: string | null; document_ref: string;
  document_sha256: string | null; status: string; created_by: string; created_at: string }
interface Oversight { id: string; kind: string; performed_on: string; outcome: string; findings: string | null; capa_ref: string | null; recorded_by: string; recorded_at: string }
interface ProviderDetail extends Omit<ProviderRow, 'agreement_gaps'> { responsibilities: string; review_interval_months: number; agreements: Agreement[];
  oversight: Oversight[]; agreement_gaps: { kind: string; category: string | null; region: string | null }[]; created_by: string; created_at: string }
interface PlatformProvider { id: string; code: string; name: string; kind: string; processing_regions: string[]; data_categories: string[]; purpose: string; status: string;
  data_region: string | null; allowed_now: boolean }

const STATUS_TONE: Record<string, Tone> = { proposed: 'neutral', qualified: 'neutral', active: 'neutral', suspended: 'warn', terminated: 'neutral' };

export function Providers() {
  const { platform } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const list = useData<{ items: ProviderRow[] }>('/v1/service-providers');
  const used = useData<{ items: PlatformProvider[] }>(platform ? `/v1/platforms/${platform.id}/providers` : null);
  if (list.error) return <ErrorNote error={list.error} />;
  if (!list.data) return <Loading />;
  const rows = list.data.items;
  const attention: AttentionItem[] = [
    ...rows.filter(p => p.overdue).map(p => ({ key: `o-${p.id}`, severity: 'warn' as const, title: `${p.code}: oversight review overdue`,
      reason: `Next review was due ${fmtDate(p.next_review_due)}; last activity ${fmtDate(p.last_activity_on)} (${human(p.last_outcome)})`, onOpen: () => setOpen(p.id) })),
    ...rows.filter(p => (p.agreement_gaps ?? 0) > 0).map(p => ({ key: `g-${p.id}`, severity: 'bad' as const, title: `${p.code}: agreements missing`,
      reason: `${p.agreement_gaps} required agreement(s) not in force for its data categories and regions`, onOpen: () => setOpen(p.id) })),
    ...(used.data?.items ?? []).filter(u => u.status === 'active' && !u.allowed_now).map(u => ({ key: `u-${u.id}`, severity: 'bad' as const,
      title: `${u.code} may not receive this platform's data now`,
      reason: `The platform data stays in ${u.data_region ?? 'no declared region'}; the provider processes in ${u.processing_regions.join(', ')} — check its status, region and agreements` })),
  ];
  return (
    <>
      <PageHeader title="Service providers" subtitle="Providers the trial work is delegated to: responsibilities, data they receive, where they process it, their agreements (DPA, BAA, APPI transfer basis, quality agreement) and the oversight done on them."
        facts={[['Providers', rows.length], ['Active', rows.filter(p => p.status === 'active').length], ['Data region of this platform', used.data?.items[0]?.data_region ?? '—']]} />
      <Panel title="Needs attention">
        <AttentionList items={attention} clear="Every provider is within its review interval, has its agreements in force, and may receive the data it is given." />
      </Panel>
      <Panel title="Registry" meta="Choose a provider to see its agreements and oversight history.">
          <DataTable rows={rows} rowKey={p => p.id} onRowClick={p => setOpen(p.id)} selectedKey={open} label="Service provider registry" columns={[
            { key: 'code', label: 'Provider', render: p => <span className="cell-stack"><span className="t-mono">{p.code}</span><small>{p.name}</small></span> },
            { key: 'kind', label: 'Kind', render: p => human(p.kind) },
            { key: 'regions', label: 'Regions', render: p => p.processing_regions.join(', ') },
            { key: 'status', label: 'Status', render: p => <StatusPill tone={STATUS_TONE[p.status] ?? 'neutral'}>{human(p.status)}</StatusPill>, sortValue: p => p.status },
            { key: 'next', label: 'Next review', sortValue: p => p.next_review_due,
              render: p => p.overdue ? <StatusPill tone="warn">{fmtDate(p.next_review_due)} overdue</StatusPill> : fmtDate(p.next_review_due) },
            { key: 'gaps', label: 'Missing agreements', align: 'right', sortValue: p => p.agreement_gaps ?? 0,
              render: p => (p.agreement_gaps ?? 0) > 0 ? <StatusPill tone="bad">{p.agreement_gaps}</StatusPill> : '0' },
          ]} />
      </Panel>
      {open ? <ProviderPanel id={open} onClose={() => setOpen(null)} /> : null}
      <Panel title="Used on this platform" meta="Participant data goes only to an active provider that processes in the platform region and has its agreements (checked by the database on activation and by the AI runtime before each call).">
        {used.error ? <ErrorNote error={used.error} /> : !used.data ? <Loading /> :
          <DataTable rows={used.data.items} rowKey={u => u.id} label="Providers used on this platform" empty={<EmptyState title="No provider used on this platform" />} columns={[
            { key: 'code', label: 'Provider', render: u => <span className="cell-stack"><span className="t-mono">{u.code}</span><small>{u.name}</small></span> },
            { key: 'purpose', label: 'Purpose', wrap: true },
            { key: 'cats', label: 'Data categories', wrap: true, render: u => u.data_categories.map(human).join(', ') },
            { key: 'regions', label: 'Processes in', render: u => u.processing_regions.join(', ') },
            { key: 'allowed', label: 'Data may go now', render: u => u.allowed_now ? 'Yes' : <StatusPill tone="bad">No</StatusPill> },
          ]} />}
      </Panel>
    </>
  );
}

function ProviderPanel({ id, onClose }: { id: string; onClose: () => void }) {
  // the detail of the provider: summary beside its agreements, oversight history below
  const d = useData<ProviderDetail>(`/v1/service-providers/${id}`);
  if (d.error) return <ErrorNote error={d.error} />;
  if (!d.data) return <Loading />;
  const p = d.data;
  return (
    <div className="grid-2">
      <Panel title={`${p.code} · ${p.name}`} actions={<Button variant="ghost" onClick={onClose}>Close</Button>}
        meta={`Recorded by ${p.created_by} on ${fmtDateTime(p.created_at)}; review every ${p.review_interval_months} months.`}>
        <DefinitionList items={[['Status', human(p.status)], ['Kind', human(p.kind)], ['GxP relevant', p.gxp_relevant ? 'Yes' : 'No'],
          ['Responsibilities', p.responsibilities], ['Data categories', p.data_categories.map(human).join(', ') || '—'], ['Processes in', p.processing_regions.join(', ')],
          ['Missing agreements', p.agreement_gaps.length ? <StatusPill tone="bad">{p.agreement_gaps.map(g => [g.kind, g.category ? human(g.category) : null, g.region].filter(Boolean).join(' ')).join('; ')}</StatusPill> : 'None']]} />
      </Panel>
      <div className="stack"><Panel title="Agreements">
        <DataTable rows={p.agreements} rowKey={a => a.id} label="Agreements" empty={<EmptyState title="No agreement recorded" />} columns={[
          { key: 'kind', label: 'Kind', render: a => <span className="cell-stack"><span>{a.kind}</span><small>{[...a.data_categories.map(human), ...a.regions].join(', ')}</small></span> },
          { key: 'period', label: 'In force', render: a => `${fmtDate(a.effective_from)} → ${a.expires_on ? fmtDate(a.expires_on) : 'open'}`, sortValue: a => a.effective_from },
          { key: 'doc', label: 'Document', wrap: true, render: a => <span className="cell-stack"><span>{a.document_ref}</span><small className="t-mono">sha256 {short(a.document_sha256)}</small></span> },
          { key: 'status', label: 'Status', render: a => human(a.status) },
        ]} />
      </Panel>
      <Panel title="Oversight history">
        <DataTable rows={p.oversight} rowKey={o => o.id} label="Oversight history" empty={<EmptyState title="No oversight recorded" />} columns={[
          { key: 'performed_on', label: 'Date', render: o => fmtDate(o.performed_on), sortValue: o => o.performed_on },
          { key: 'kind', label: 'Activity', render: o => human(o.kind) },
          { key: 'outcome', label: 'Outcome', render: o => o.outcome === 'unsatisfactory' ? <StatusPill tone="bad">{human(o.outcome)}</StatusPill> : human(o.outcome) },
          { key: 'by', label: 'Recorded by', render: o => <span className="cell-stack"><span>{o.recorded_by}</span><small>{fmtDateTime(o.recorded_at)}</small></span> },
        ]} />
      </Panel></div>
    </div>
  );
}
