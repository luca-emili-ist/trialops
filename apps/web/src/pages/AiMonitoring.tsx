// TRO-052 AI monitoring (AI-10, AI-08): per AI task type the human outcome of its proposals, validation failures, drift
// and the rules of its credibility plan; below threshold a task type falls back to suggestion-only. Exceptions first (P3):
// task types in suggestion-only, rules crossed, drift and unsigned decision records are listed with their reason (P6).
// The autonomy of each task type (P7) is changed only by a platform admin, after seeing the change (P4) and with a reason.
// Readers: QA auditors and platform admins (the API enforces the same rule). English only (platform administration).
import { useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, EmptyState, DefinitionList, AttentionList, ReasonDialog, SelectField, useToast, type AttentionItem } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { fmtDateTime, human } from '../format.ts';

export const AI_MONITORING_ROLES = ['qa_auditor', 'platform_admin'] as const;

type Mode = 'normal' | 'suggestion_only';
interface Rule { metric: string; max: number; min_sample: number; value: number | null; sample: number; breach: boolean }
interface Monitor {
  task_type: string; gxp: boolean; risk: string; model: string; prompt_version: number; mode: Mode; breach: boolean; window: number; since: string | null;
  state: { mode: Mode; reason: string; source: string; changed_by: string; changed_at: string } | null;
  metrics: { calls: number; reviewed: number; accepted: number; edited: number; rejected: number; acceptance_rate: number | null; edit_rate: number | null;
    rejection_rate: number | null; validation_failure_rate: number | null; unsupported_items: number; generated_tasks: number;
    generated_tasks_cancelled_or_reassigned_rate: number | null; outcomes: Record<string, number> };
  drift: { signal: 'stable' | 'drift' | 'insufficient_data'; window: number; last_calls: number; previous_calls: number; output_tokens_change: number | null;
    failure_rate_change: number | null };
  rules: Rule[];
}
interface Monitoring { platform_id: string; items: Monitor[];
  decision_records: { total: number; unsigned: number; signer: { mode: string; key_id: string | null }; anomalies: string[] } }

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);
/** A rule value: rates as percentages, counts as numbers. */
const val = (metric: string, v: number | null | undefined) => (metric.endsWith('_rate') ? pct(v) : v === null || v === undefined ? '—' : String(v));
const MODE_LABEL: Record<Mode, string> = { normal: 'Normal: the agent acts within its tool modes', suggestion_only: 'Suggestion only: a person confirms every output' };

export function AiMonitoring() {
  const s = useSession();
  const toast = useToast();
  const allowed = s.can(...AI_MONITORING_ROLES);
  const admin = s.can('platform_admin');
  const pid = s.platform?.id;
  const mon = useData<Monitoring>(allowed && pid ? `/v1/ai/monitoring?platform_id=${pid}` : null);
  const [open, setOpen] = useState<string | null>(null);
  const [change, setChange] = useState<{ task_type: string; from: Mode; to: Mode } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!allowed) return <EmptyState title="AI monitoring is read by QA auditors and platform administrators" />;
  if (mon.error) return <ErrorNote error={mon.error} />;
  if (!mon.data) return <Loading what="Computing the monitoring" />;
  const d = mon.data;
  const selected = d.items.find(i => i.task_type === open) ?? null;

  // Exceptions first (P3), each with its reason (P6).
  const attention: AttentionItem[] = [
    ...d.items.filter(i => i.mode === 'suggestion_only').map(i => ({ key: `mode-${i.task_type}`, severity: 'warn' as const,
      title: `${i.task_type} is in suggestion-only mode`, reason: i.state?.reason ?? 'Set by a platform administrator', value: 'Suggestion only',
      target: i.state ? `${i.state.source} · ${fmtDateTime(i.state.changed_at)}` : undefined, onOpen: () => setOpen(i.task_type) })),
    ...d.items.filter(i => i.breach).map(i => ({ key: `breach-${i.task_type}`, severity: 'bad' as const, title: `${i.task_type}: monitoring rule crossed`,
      reason: i.rules.filter(r => r.breach).map(r => `${human(r.metric)} ${val(r.metric, r.value)} above ${val(r.metric, r.max)} (n = ${r.sample})`).join('; '),
      onOpen: () => setOpen(i.task_type) })),
    ...d.items.filter(i => i.drift.signal === 'drift').map(i => ({ key: `drift-${i.task_type}`, severity: 'warn' as const, title: `${i.task_type}: drift`,
      reason: `Output size ${pct(i.drift.output_tokens_change)} and failure rate ${pct(i.drift.failure_rate_change)} over the last ${i.drift.last_calls} calls against the ${i.drift.previous_calls} before`,
      onOpen: () => setOpen(i.task_type) })),
    ...d.decision_records.anomalies.map((a, n) => ({ key: `adr-${n}`, severity: 'bad' as const, title: 'Agent Decision Records', reason: a })),
  ];

  const evaluate = async () => {
    setBusy(true);
    try {
      const r = await api<{ switched: string[] }>('POST', '/v1/ai/monitoring/evaluate', { body: { platform_id: pid } });
      toast(r.switched.length ? `Moved to suggestion-only: ${r.switched.join(', ')}` : 'Evaluated: no task type crossed its rules');
      mon.reload();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="AI monitoring" subtitle="How people judged the outputs of each AI task type, validation failures and drift, against the rules of its credibility plan. A task type that crosses a rule falls back to suggestion-only; only a platform administrator puts it back, with a reason."
        facts={[['Task types', d.items.length], ['Suggestion-only', d.items.filter(i => i.mode === 'suggestion_only').length],
          ['Decision records', `${d.decision_records.total} · ${d.decision_records.unsigned} unsigned`], ['Signing key', d.decision_records.signer.mode]]}
        actions={admin ? <Button variant="primary" disabled={busy} onClick={() => { void evaluate(); }}>{busy ? 'Evaluating…' : 'Evaluate now'}</Button> : undefined} />
      <Panel title="Needs attention" meta={`${attention.length} item(s). Evaluating records the switch to suggestion-only; it never switches back to normal.`}>
        <AttentionList items={attention} clear="Every task type is in normal mode, within its rules and without drift; every decision record is signed." />
      </Panel>
      <Panel title="Task types" meta="Choose a task type to see its rules, its drift and who set its mode.">
          <DataTable rows={d.items} rowKey={i => i.task_type} onRowClick={i => setOpen(i.task_type)} selectedKey={open} label="Task types" columns={[
            { key: 'task_type', label: 'Task type', render: i => <span className="t-mono">{i.task_type}</span> },
            { key: 'mode', label: 'Mode', sortValue: i => i.mode, render: i => <StatusPill tone={i.mode === 'suggestion_only' ? 'warn' : 'neutral'}>{human(i.mode)}</StatusPill> },
            { key: 'calls', label: 'Calls', align: 'right', render: i => i.metrics.calls, sortValue: i => i.metrics.calls },
            { key: 'reviewed', label: 'Reviewed', align: 'right', render: i => i.metrics.reviewed, sortValue: i => i.metrics.reviewed },
            { key: 'rejection', label: 'Rejected', align: 'right', render: i => pct(i.metrics.rejection_rate), sortValue: i => i.metrics.rejection_rate },
            { key: 'edit', label: 'Edited', align: 'right', render: i => pct(i.metrics.edit_rate), sortValue: i => i.metrics.edit_rate },
            { key: 'drift', label: 'Drift', render: i => i.drift.signal === 'drift' ? <StatusPill tone="warn">Drift</StatusPill> : human(i.drift.signal) },
            { key: 'rules', label: 'Rules', render: i => i.breach ? <StatusPill tone="bad">Crossed</StatusPill> : 'Within' },
          ]} />
      </Panel>
      {selected ? <TaskTypeDetail m={selected} admin={admin} onClose={() => setOpen(null)}
        onMode={to => setChange({ task_type: selected.task_type, from: selected.mode, to })} /> : null}
      {change ? <ReasonDialog title={`Change the mode of ${change.task_type}`} confirmLabel="Change mode"
        description={`${MODE_LABEL[change.from]} → ${MODE_LABEL[change.to]}. ${change.to === 'normal'
          ? 'Back to normal: the agent acts again within the modes of its tools. Record why the cause is solved.' : 'Every output of the agent then waits for a person.'}`}
        onClose={() => setChange(null)} onConfirm={async reason => {
          await api('POST', '/v1/ai/monitoring/mode', { reason, body: { platform_id: pid, task_type: change.task_type, mode: change.to } });
          setChange(null); toast('Mode changed'); mon.reload();
        }} /> : null}
    </>
  );
}

function TaskTypeDetail({ m, admin, onClose, onMode }: { m: Monitor; admin: boolean; onClose: () => void; onMode: (to: Mode) => void }) {
  const [to, setTo] = useState<Mode>(m.mode === 'normal' ? 'suggestion_only' : 'normal');
  return (
    <Panel title={m.task_type} actions={<Button variant="ghost" onClick={onClose}>Close</Button>}
      meta={m.since ? `Metrics since the last change of mode, ${fmtDateTime(m.since)}; window of the last ${m.window} reviewed outputs.` : `Window of the last ${m.window} reviewed outputs.`}>
      <DefinitionList items={[
        ['Mode', <StatusPill tone={m.mode === 'suggestion_only' ? 'warn' : 'neutral'}>{human(m.mode)}</StatusPill>],
        ['Set by', m.state ? `${m.state.changed_by} · ${human(m.state.source)} · ${fmtDateTime(m.state.changed_at)}` : 'Default (never changed)'],
        ...(m.state?.reason ? [['Reason', m.state.reason] as [string, string]] : []),
        ['Model · prompt', <span className="t-mono">{m.model} · v{m.prompt_version}</span>], ['GxP · risk', `${m.gxp ? 'GxP' : 'Not GxP'} · ${m.risk}`],
        ['Outcomes', Object.entries(m.metrics.outcomes).map(([k, v]) => `${human(k)} ${v}`).join(' · ')],
        ['Validation failures', pct(m.metrics.validation_failure_rate)], ['Unsupported items (citation)', m.metrics.unsupported_items],
        ['Drift', `${human(m.drift.signal)} · output size ${pct(m.drift.output_tokens_change)} · failure rate ${pct(m.drift.failure_rate_change)}`],
      ]} />
      <DataTable rows={m.rules} rowKey={r => r.metric} label="Rules of the credibility plan" columns={[
        { key: 'metric', label: 'Rule', wrap: true, render: r => human(r.metric) },
        { key: 'value', label: 'Value', align: 'right', render: r => val(r.metric, r.value), sortValue: r => r.value },
        { key: 'max', label: 'Maximum', align: 'right', render: r => val(r.metric, r.max) },
        { key: 'sample', label: 'Sample', align: 'right', render: r => `${r.sample} / ${r.min_sample}` },
        { key: 'breach', label: 'Result', render: r => r.breach ? <StatusPill tone="bad">Crossed</StatusPill> : r.sample < r.min_sample ? 'Too few' : 'Within' },
      ]} />
      {admin ? <div className="stack-sm">
        <SelectField label="Autonomy of this task type (P7)" value={to} onChange={e => setTo(e.target.value as Mode)}
          options={(['normal', 'suggestion_only'] as Mode[]).filter(x => x !== m.mode).map(x => ({ value: x, label: MODE_LABEL[x] }))} />
        <DefinitionList items={[['Now', MODE_LABEL[m.mode]], ['After the change', <strong>{MODE_LABEL[to]}</strong>]]} />
        <div><Button variant="primary" onClick={() => onMode(to)}>Change mode…</Button></div>
      </div> : null}
    </Panel>
  );
}
