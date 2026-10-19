// TRO-001 Platform overview: arms, sites, enrollment, SURPASS metrics against target with drill-down to the event.
// Landing page of every person, site staff included: localised in English and Japanese (NFR-07).
import { useState } from 'react';
import { PageHeader, KeyFigures, Panel, DataTable, StatusPill, MetricBar, Button, Loading, ErrorNote, DefinitionList, EmptyState, AttentionList, useT } from '@trialops/shell';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { fmtDateTime, human, tone, METRIC_LABEL } from '../format.ts';

interface Overview { id: string; code: string; title: string; lead_operator: string; arms: { id: string; code: string; name: string; status: string; current_stage: string | null; sponsor: string | null; intervention_type: string }[];
  sites: { n: number; active: number }; enrollment: { identified: number; prescreened: number; consented: number; randomized: number }; open_tasks: number }
interface MetricValue { arm_id: string | null; arm_code: string | null; value: number | null; status: string }
interface Metric { code: string; name: string; unit: string; interim_target: number | null; final_target: number | null; per_arm: boolean; headline: MetricValue | null; values: MetricValue[] }

export function Dashboard() {
  const { platform } = useSession();
  const t = useT();
  const pid = platform?.id;
  const ov = useData<Overview>(pid ? `/v1/platforms/${pid}` : null);
  const metrics = useData<{ items: Metric[]; computed_at: string }>(pid ? `/v1/platforms/${pid}/metrics` : null);
  const review = useData<{ items: { state: string }[] }>(pid ? `/v1/platforms/${pid}/tasks?mine=true` : null);
  const [drill, setDrill] = useState<{ code: string; arm: string | null } | null>(null);
  if (!pid) return <EmptyState title={t('No platform assigned')}>{t('Ask a platform administrator for access.')}</EmptyState>;
  if (ov.error) return <ErrorNote error={ov.error} />;
  if (!ov.data) return <Loading />;
  const o = ov.data;
  const active = o.arms.filter(a => a.status === 'active');
  const rows = (metrics.data?.items ?? []).flatMap(m => (m.per_arm ? m.values : [m.headline ?? { arm_id: null, arm_code: null, value: null, status: 'no_data' }])
    .map(v => ({ m, v, key: `${m.code}:${v.arm_id ?? 'platform'}` })))
    .sort((a, b) => Number(a.v.value === null) - Number(b.v.value === null));   // measured metrics first
  const target = (m: Metric) => [m.interim_target !== null ? t('interim {n}', { n: m.interim_target }) : null, m.final_target !== null ? t('final {n}', { n: m.final_target }) : null]
    .filter(Boolean).join(' · ');
  // Exceptions first (P3): off-target metrics get their own list with the reason; the rest stays neutral in the table.
  const offTarget = rows.filter(r => r.v.status === 'off_target');
  return (
    <>
      <PageHeader crumbs={o.lead_operator} title={`${o.code} — ${o.title}`}
        subtitle={t('Arms, sites and enrollment of the platform, with the SURPASS TA3 metrics measured from records.')}
        actions={<Button variant="primary" onClick={() => go('/arms/new')}>{t('Start new arm')}</Button>} />
      <KeyFigures items={[
        { label: t('Arms active'), value: t('{n} + control', { n: active.filter(a => a.intervention_type !== 'control').length }), note: t('{n} in total', { n: o.arms.length }) },
        { label: t('Sites active'), value: t('{a} of {n}', { a: o.sites.active, n: o.sites.n }) },
        { label: t('Subjects randomized'), value: o.enrollment.randomized, note: t('{n} identified', { n: o.enrollment.identified }) },
        { label: t('My open tasks'), value: review.data?.items.length ?? '—', note: t('{n} awaiting review', { n: review.data?.items.filter(x => x.state === 'waiting_review').length ?? 0 }) },
      ]} />
      <div className="grid-2">
        <div className="stack">
        <Panel title={t('Needs attention')} meta={metrics.data ? t('{a} of {n} measures off target', { a: offTarget.length, n: rows.length }) : undefined}>
          {metrics.error ? <ErrorNote error={metrics.error} /> : !metrics.data ? <Loading /> :
            <AttentionList clear={t('Every SURPASS TA3 measure is within target or has no data yet.')} items={offTarget.map(r => ({
              key: r.key, severity: 'bad' as const, title: `${r.v.arm_code ?? t('Platform')} · ${r.m.name}`,
              reason: t('Off target. Open it to see the records and events behind the value.'),
              value: r.v.value === null ? '—' : `${r.v.value} ${r.m.unit}`, target: target(r.m) || undefined,
              onOpen: () => setDrill({ code: r.m.code, arm: r.v.arm_id }),
            }))} />}
        </Panel>
        <Panel title={t('SURPASS TA3 metrics against target')} meta={metrics.data ? t('Computed from records at {when} · bar marks: interim (ink) and final (green) target', { when: fmtDateTime(metrics.data.computed_at) }) : undefined}>
          {metrics.error ? <ErrorNote error={metrics.error} /> : !metrics.data ? <Loading /> :
            <DataTable rows={rows} rowKey={r => r.key} selectedKey={drill ? `${drill.code}:${drill.arm ?? 'platform'}` : null} label={t('SURPASS TA3 metrics against target')}
              onRowClick={r => setDrill({ code: r.m.code, arm: r.v.arm_id })}
              columns={[
                { key: 'metric', wrap: true, label: t('Metric'), render: r => r.m.name, sortValue: r => r.m.name },
                { key: 'arm', label: t('Arm'), render: r => r.v.arm_code ?? t('Platform'), sortValue: r => r.v.arm_code },
                { key: 'value', label: t('Measured'), align: 'right', render: r => r.v.value === null ? '—' : `${r.v.value} ${r.m.unit}`, sortValue: r => r.v.value },
                { key: 'bar', label: t('Interim · final'), render: r => <MetricBar value={r.v.value} interim={r.m.interim_target} final={r.m.final_target}
                  tone={r.v.status === 'off_target' ? 'bad' : undefined} /> },
                { key: 'status', label: t('Status'), render: r => <StatusPill tone={tone(r.v.status)}>{t(METRIC_LABEL[r.v.status] ?? human(r.v.status))}</StatusPill>, sortValue: r => r.v.status },
              ]} />}
        </Panel>
        </div>
        {drill ? <Drilldown pid={pid} code={drill.code} arm={drill.arm} onClose={() => setDrill(null)} /> :
          <Panel title={t('Arms')}>
            <DataTable label={t('Arms')} rows={o.arms} rowKey={a => a.id} onRowClick={a => go(`/arms/${a.id}`)} columns={[
              { key: 'code', label: t('Arm') }, { key: 'name', wrap: true, label: t('Intervention') },
              { key: 'sponsor', label: t('Sponsor'), render: a => a.sponsor ?? t('Platform') },
              { key: 'status', label: t('Status'), render: a => <StatusPill tone={tone(a.status)}>{t(human(a.status))}</StatusPill>, sortValue: a => a.status },
              { key: 'stage', label: t('Stage'), render: a => t(human(a.current_stage)), sortValue: a => a.current_stage },
            ]} />
          </Panel>}
      </div>
    </>
  );
}

interface Drill { definition: { name: string; formula: string; unit: string; source_events: string[] };
  values: (MetricValue & { sources: { label: string; at: string | null; table: string }[]; events: { label: string; at: string | null; id: string }[] })[] }

function Drilldown({ pid, code, arm, onClose }: { pid: string; code: string; arm: string | null; onClose: () => void }) {
  const t = useT();
  const d = useData<Drill>(`/v1/platforms/${pid}/metrics/${code}${arm ? `?arm_id=${arm}` : ''}`);
  return (
    <Panel title={d.data?.definition.name ?? code} actions={<Button variant="ghost" onClick={onClose}>{t('Back to arms')}</Button>}
      meta={d.data ? t('Source events: {list}', { list: d.data.definition.source_events.join(', ') || t('none yet') }) : undefined}>
      {d.error ? <ErrorNote error={d.error} /> : !d.data ? <Loading /> : <>
        <DefinitionList items={[[t('Formula'), <span className="t-mono">{d.data.definition.formula}</span>], [t('Code'), <span className="t-mono">{code}</span>]]} />
        {d.data.values.map(v => (
          <div className="stack-sm" key={v.arm_id ?? 'p'}>
            <strong>{v.arm_code ?? t('Platform')} · {v.value ?? '—'} {d.data!.definition.unit} · <StatusPill tone={tone(v.status)}>{t(METRIC_LABEL[v.status] ?? v.status)}</StatusPill></strong>
            <DataTable rows={[...v.sources.map((s, i) => ({ k: `s${i}`, kind: t('Record'), label: s.label, at: s.at })),
              ...v.events.map(e => ({ k: e.id, kind: t('Event'), label: e.label, at: e.at }))]} rowKey={r => r.k} label={t('Sources of {code}', { code })}
              columns={[{ key: 'kind', label: t('Kind') }, { key: 'label', label: t('Source'), wrap: true }, { key: 'at', label: t('When'), render: r => fmtDateTime(r.at), sortValue: r => r.at }]}
              empty={<EmptyState title={t('No source records yet')} />} />
          </div>))}
      </>}
    </Panel>
  );
}
