// TRO-050 AI ledger: every model call with model, prompt version, hashes, cost and the human decision (AI-01, AI-05, AI-06).
import { PageHeader, Panel, DataTable, StatusPill, Loading, ErrorNote, KeyFigures } from '@trialops/shell';
import { useData, useSession } from '../session.tsx';
import { fmtDateTime, human, tone, short } from '../format.ts';

interface Req { id: string; task_type: string; data_class: string; provider: string; model: string; prompt_id: string; prompt_version: number; input_sha256: string;
  output_sha256: string | null; input_tokens: number | null; output_tokens: number | null; cost_eur: string | null; latency_ms: number | null; outcome: string;
  review_decision: string | null; reviewer_sub: string | null; requested_by: string; created_at: string }
interface Stat { task_type: string; calls: number; reviewed: number; accepted: number; edited: number; rejected: number }
interface TaskType { task_type: string; intended_use: string; risk: string; gxp: boolean; model: string; prompt_id: string; prompt_version: number; data_classes: string[] }

export function AiLedger() {
  const { platform } = useSession();
  const reqs = useData<{ items: Req[] }>(platform ? `/v1/platforms/${platform.id}/ai-requests` : null);
  const stats = useData<{ items: Stat[] }>(platform ? `/v1/platforms/${platform.id}/ai-review-stats` : null);
  const types = useData<{ items: TaskType[]; provider: string | null }>('/v1/ai/task-types');
  const total = (stats.data?.items ?? []).reduce((a, s) => ({ calls: a.calls + s.calls, reviewed: a.reviewed + s.reviewed, accepted: a.accepted + s.accepted }), { calls: 0, reviewed: 0, accepted: 0 });
  const cost = (reqs.data?.items ?? []).reduce((a, r) => a + Number(r.cost_eur ?? 0), 0);
  return (
    <>
      <PageHeader title="AI ledger" subtitle="Every call to a model goes through the AI runtime and is recorded here. Outputs that touch GxP data are proposals until a person signs." />
      <KeyFigures items={[{ label: 'Model calls', value: total.calls }, { label: 'Reviewed by a person', value: total.reviewed },
        { label: 'Accepted without edits', value: total.reviewed ? `${Math.round((total.accepted / total.reviewed) * 100)}%` : '—' },
        { label: 'Cost (list price)', value: `€ ${cost.toFixed(4)}`, note: types.data?.provider === 'replay' ? 'Recorded responses: no live calls' : undefined }]} />
      <Panel title="Calls">
        {reqs.error ? <ErrorNote error={reqs.error} /> : !reqs.data ? <Loading /> :
          <DataTable rows={reqs.data.items} rowKey={r => r.id} columns={[
            { key: 'created_at', label: 'When', render: r => fmtDateTime(r.created_at), sortValue: r => r.created_at },
            { key: 'task_type', label: 'Task type', render: r => <span className="t-mono">{r.task_type}</span> },
            { key: 'requested_by', label: 'Requested by' },
            { key: 'model', label: 'Model · prompt', render: r => <span className="t-mono">{r.model} · {r.prompt_id} v{r.prompt_version}</span> },
            { key: 'data_class', label: 'Data class', render: r => human(r.data_class) },
            { key: 'hash', label: 'Input · output hash', render: r => <span className="t-mono">{short(r.input_sha256)} · {short(r.output_sha256)}</span> },
            { key: 'outcome', label: 'Outcome', render: r => <StatusPill tone={tone(r.outcome)}>{human(r.outcome)}</StatusPill>, sortValue: r => r.outcome },
            { key: 'review', label: 'Human decision', render: r => r.review_decision ? <StatusPill tone={tone(r.review_decision)}>{human(r.review_decision)} · {r.reviewer_sub}</StatusPill> : '—' },
          ]} />}
      </Panel>
      <div className="grid-2">
        <Panel title="Acceptance by task type">
          <DataTable rows={stats.data?.items ?? []} rowKey={s => s.task_type} columns={[
            { key: 'task_type', label: 'Task type', render: s => <span className="t-mono">{s.task_type}</span> },
            { key: 'calls', label: 'Calls', align: 'right', render: s => s.calls }, { key: 'accepted', label: 'Accepted', align: 'right', render: s => s.accepted },
            { key: 'edited', label: 'Edited', align: 'right', render: s => s.edited }, { key: 'rejected', label: 'Rejected', align: 'right', render: s => s.rejected }]} />
        </Panel>
        <Panel title="Registered task types">
          <DataTable rows={types.data?.items ?? []} rowKey={t => t.task_type} columns={[
            { key: 'task_type', label: 'Task type', render: t => <span className="t-mono">{t.task_type}</span> },
            { key: 'risk', label: 'Risk', render: t => <StatusPill tone={t.risk === 'high' ? 'bad' : t.risk === 'medium' ? 'warn' : 'neutral'}>{t.risk}</StatusPill> },
            { key: 'gxp', label: 'Human signature', render: t => t.gxp ? 'Required' : 'Not required' },
            { key: 'model', label: 'Validated model', render: t => <span className="t-mono">{t.model}</span> }]} />
        </Panel>
      </div>
    </>
  );
}
