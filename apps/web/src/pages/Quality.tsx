// TRO-054 Quality & risk (CMP-05, ICH E6(R3) §3.10 and Annex 1): critical-to-quality factors with their risks, key risk
// indicators and quality tolerance limits. Exceptions first (P3): breached limits and high risks with their reason (P6);
// every observation shows who recorded it and when (P5). Read view: the register is maintained through the API by platform
// admins, operations managers and QA auditors. English only (platform administration).
import { PageHeader, Panel, DataTable, StatusPill, Loading, ErrorNote, EmptyState, AttentionList, KeyFigures, type AttentionItem } from '@trialops/shell';
import { useData, useSession } from '../session.tsx';
import { fmtDate, fmtDateTime, human } from '../format.ts';

export const QUALITY_ROLES = ['platform_admin', 'platform_ops_manager', 'qa_auditor'] as const;

interface Risk { id: string; code: string; description: string; likelihood: number; impact: number; detectability: number; risk_score: number; controls: string;
  owner_role: string; status: string; review_due: string | null; created_by: string; created_at: string }
interface Limit { id: string; code: string; kind: 'KRI' | 'QTL'; metric: string; description: string; unit: string; lower_limit: string | null; upper_limit: string | null;
  status: string }
interface Factor { id: string; code: string; title: string; category: string; rationale: string; status: string; arm_id: string | null; created_by: string;
  created_at: string; risks: Risk[]; limits: Limit[] }
interface Observation { id: string; code: string; kind: string; metric: string; unit: string; value: string; lower_limit: string | null; upper_limit: string | null;
  source: string; note: string | null; breached: boolean; breach_task_id: string | null; observed_by: string; observed_at: string }

/** Risk score = likelihood × impact × detectability (1–125). Display threshold of this page: 48 and above is shown first as high
 * (the procedure RBQM_AND_PROVIDERS.md sets no threshold yet; open point of the review note). */
const HIGH_RISK = 48;
const range = (l: { lower_limit: string | null; upper_limit: string | null; unit: string }) =>
  [l.lower_limit !== null ? `≥ ${l.lower_limit}` : null, l.upper_limit !== null ? `≤ ${l.upper_limit}` : null].filter(Boolean).join(' and ') + ` ${l.unit}`;

export function Quality() {
  const { platform } = useSession();
  const pid = platform?.id;
  const ctq = useData<{ items: Factor[] }>(pid ? `/v1/platforms/${pid}/ctq-factors` : null);
  const obs = useData<{ items: Observation[] }>(pid ? `/v1/platforms/${pid}/quality-limits/observations` : null);
  if (ctq.error) return <ErrorNote error={ctq.error} />;
  if (!ctq.data) return <Loading />;
  const factors = ctq.data.items;
  const risks = factors.flatMap(f => f.risks.map(r => ({ ...r, factor: f.code })));
  const limits = factors.flatMap(f => f.limits.map(l => ({ ...l, factor: f.code })));
  // latest observation per limit
  const latest = new Map<string, Observation>();
  for (const o of obs.data?.items ?? []) if (!latest.has(o.code)) latest.set(o.code, o);
  const breached = [...latest.values()].filter(o => o.breached);
  const attention: AttentionItem[] = [
    ...breached.map(o => ({ key: `b-${o.id}`, severity: o.kind === 'QTL' ? 'bad' as const : 'warn' as const, title: `${o.code} · ${o.kind} breached`,
      reason: `${human(o.metric)} measured ${o.value} ${o.unit} on ${fmtDateTime(o.observed_at)} by ${o.observed_by}${o.note ? ` — ${o.note}` : ''}${o.breach_task_id ? '; a review task is open' : ''}`,
      value: `${o.value} ${o.unit}`, target: range(o) })),
    ...risks.filter(r => r.risk_score >= HIGH_RISK && r.status !== 'closed').map(r => ({ key: `r-${r.id}`, severity: 'warn' as const,
      title: `${r.code} · high risk (${r.risk_score})`, reason: `${r.description}. Owner: ${human(r.owner_role)}. Controls: ${r.controls}` })),
  ];
  return (
    <>
      <PageHeader title="Quality & risk" subtitle="Critical-to-quality factors of the platform, the risks that threaten them, and the key risk indicators and quality tolerance limits measured from the records (ICH E6(R3) risk-based quality management)."
        facts={[['CtQ factors', factors.length], ['Risks', risks.length], ['KRIs · QTLs', `${limits.filter(l => l.kind === 'KRI').length} · ${limits.filter(l => l.kind === 'QTL').length}`]]} />
      <Panel title="Needs attention" meta="Breaches open a review task for the operations manager; the register itself is maintained through the Platform API.">
        {obs.error ? <ErrorNote error={obs.error} /> : <AttentionList items={attention} clear="No limit breached at its latest observation and no high risk open." />}
      </Panel>
      <KeyFigures items={[{ label: 'Limits breached now', value: breached.length, note: `${latest.size} limits observed` },
        { label: 'Highest risk score', value: risks.length ? Math.max(...risks.map(r => r.risk_score)) : '—', note: 'likelihood × impact × detectability' },
        { label: 'Observations', value: obs.data?.items.length ?? '—' }]} />
      <Panel title="Critical-to-quality factors">
        <DataTable rows={factors} rowKey={f => f.id} label="Critical-to-quality factors" empty={<EmptyState title="No CtQ factor recorded" />} columns={[
          { key: 'code', label: 'Code', render: f => <span className="t-mono">{f.code}</span> },
          { key: 'title', label: 'Factor', wrap: true, render: f => <span className="cell-stack"><span>{f.title}</span><small>{f.rationale}</small></span> },
          { key: 'category', label: 'Category', render: f => human(f.category) },
          { key: 'scope', label: 'Scope', render: f => f.arm_id ? 'Arm' : 'Platform' },
          { key: 'n', label: 'Risks · limits', align: 'right', render: f => `${f.risks.length} · ${f.limits.length}` },
        ]} />
      </Panel>
      <Panel title="Risk register">
        <DataTable rows={risks} rowKey={r => r.id} label="Risk register" empty={<EmptyState title="No risk recorded" />} columns={[
          { key: 'code', label: 'Risk', render: r => <span className="cell-stack"><span className="t-mono">{r.code}</span><small>{r.factor}</small></span> },
          { key: 'description', label: 'Description and controls', wrap: true, render: r => <span className="cell-stack"><span>{r.description}</span><small>{r.controls}</small></span> },
          { key: 'risk_score', label: 'Score', align: 'right', sortValue: r => r.risk_score,
            render: r => <span title={`likelihood ${r.likelihood} × impact ${r.impact} × detectability ${r.detectability}`}>{r.risk_score >= HIGH_RISK
              ? <StatusPill tone="warn">{r.risk_score} high</StatusPill> : r.risk_score}</span> },
          { key: 'owner_role', label: 'Owner', render: r => human(r.owner_role) },
          { key: 'status', label: 'Status', render: r => human(r.status), sortValue: r => r.status },
          { key: 'review_due', label: 'Review due', render: r => fmtDate(r.review_due), sortValue: r => r.review_due },
        ]} />
      </Panel>
      <Panel title="Key risk indicators and quality tolerance limits">
        <DataTable rows={limits} rowKey={l => l.id} label="Key risk indicators and quality tolerance limits" empty={<EmptyState title="No limit recorded" />} columns={[
          { key: 'code', label: 'Limit', render: l => <span className="cell-stack"><span className="t-mono">{l.code}</span><small>{l.kind} · {l.factor}</small></span> },
          { key: 'description', label: 'Measure', wrap: true, render: l => <span className="cell-stack"><span>{l.description}</span><small className="t-mono">{l.metric}</small></span> },
          { key: 'range', label: 'Tolerance', render: l => range(l) },
          { key: 'latest', label: 'Latest', align: 'right', render: l => { const o = latest.get(l.code); return o
            ? o.breached ? <StatusPill tone={l.kind === 'QTL' ? 'bad' : 'warn'}>{o.value} breached</StatusPill> : o.value : '—'; } },
          { key: 'when', label: 'Observed', render: l => { const o = latest.get(l.code); return o ? <span className="cell-stack"><span>{fmtDateTime(o.observed_at)}</span>
            <small>{o.observed_by} · {human(o.source)}</small></span> : '—'; } },
        ]} />
      </Panel>
    </>
  );
}
