// TRO-030 Task inbox and TRO-031 Task detail: state history, agent run, review of agent proposals (AI-05, APP-TK-04).
import { useState, type ReactNode } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, DefinitionList, SelectField, SignDialog, DiffList, EmptyState, useToast,
  SignatureManifest, AiProvenance, type SectionDiff, type SignatureLike, type AiProvenanceLike } from '@trialops/shell';
import { api, runJob } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { fmtDate, fmtDateTime, human, tone } from '../format.ts';
import { SECTIONS, SectionEditor, clean, type Content } from '../components/ProtocolSections.tsx';

interface Task { id: string; type: string; title: string; arm_code: string | null; assignee_kind: string; assignee: string; state: string; gxp_impact: boolean;
  priority: string; due_at: string | null; created_at: string; inputs?: Content; outputs?: Content | null; review_signature?: SignatureLike | null; events?: { from_state: string | null; to_state: string; actor_sub: string; actor_type: string; at: string }[] }

export function Tasks() {
  const { platform } = useSession();
  const [mine, setMine] = useState('true');
  const [state, setState] = useState('open');
  const tasks = useData<{ items: Task[] }>(platform ? `/v1/platforms/${platform.id}/tasks?mine=${mine}&state=${state}` : null);
  return (
    <>
      <PageHeader title="Tasks" subtitle="Work assigned to people, roles, agents and apps. GxP tasks done by an agent wait for a person's review and signature." />
      <div className="form-grid">
        <SelectField label="Assigned to" value={mine} onChange={e => setMine(e.target.value)} options={[{ value: 'true', label: 'Me and my roles' }, { value: 'false', label: 'Everyone' }]} />
        <SelectField label="State" value={state} onChange={e => setState(e.target.value)} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />
      </div>
      {tasks.error ? <ErrorNote error={tasks.error} /> : !tasks.data ? <Loading /> :
        <DataTable rows={tasks.data.items} rowKey={t => t.id} onRowClick={t => go(`/tasks/${t.id}`)}
          empty={<EmptyState title="No tasks here">Nothing is waiting for you.</EmptyState>} columns={[
            { key: 'title', wrap: true, label: 'Task' }, { key: 'arm_code', label: 'Arm', render: t => t.arm_code ?? '—' },
            { key: 'assignee', label: 'Assigned to', render: t => t.assignee_kind === 'agent' ? `Agent · ${t.assignee.replace('agent:', '')}` : human(t.assignee) },
            { key: 'gxp', label: 'GxP', render: t => t.gxp_impact ? <StatusPill tone="info">GxP</StatusPill> : '—', sortValue: t => (t.gxp_impact ? 1 : 0) },
            { key: 'state', label: 'State', render: t => <StatusPill tone={tone(t.state)}>{human(t.state)}</StatusPill>, sortValue: t => t.state },
            { key: 'due_at', label: 'Due', render: t => fmtDate(t.due_at), sortValue: t => t.due_at },
          ]} />}
    </>
  );
}

export function TaskDetail({ id }: { id: string }) {
  const s = useSession();
  const toast = useToast();
  const task = useData<Task>(`/v1/tasks/${id}`);
  const [busy, setBusy] = useState(false);
  if (task.error) return <ErrorNote error={task.error} />;
  if (!task.data) return <Loading />;
  const t = task.data;
  const runnable = t.assignee_kind === 'agent' && ['assigned', 'in_progress'].includes(t.state) && s.can('platform_admin', 'platform_ops_manager');
  return (
    <>
      <PageHeader crumbs={<a href="#/tasks">Tasks</a>} title={t.title}
        actions={runnable ? <Button variant="primary" disabled={busy} onClick={() => { setBusy(true); runJob<{ outcome: string; error?: string }>('POST', `/v1/tasks/${id}/run-agent`)
          .then(r => toast(r.outcome === 'success' ? 'Agent finished' : `Agent: ${r.outcome} ${r.error ?? ''}`, r.outcome !== 'success'), e => toast((e as Error).message, true))
          .finally(() => { setBusy(false); task.reload(); }); }}>{busy ? 'Agent working…' : 'Run the agent'}</Button> : undefined} />
      <div className="grid-2">
        <Panel title="Task">
          <DefinitionList items={[
            ['State', <StatusPill tone={tone(t.state)}>{human(t.state)}</StatusPill>], ['Type', <span className="t-mono">{t.type}</span>],
            ['Assigned to', t.assignee_kind === 'agent' ? `Agent ${t.assignee}` : human(t.assignee)], ['Arm', t.arm_code ?? '—'],
            ['GxP impact', t.gxp_impact ? 'Yes — a person signs the outcome' : 'No'], ['Due', fmtDate(t.due_at)],
            ...(t.outputs?.ai_request_id ? [['AI request', <a href="#/ai" className="t-mono">{String(t.outputs.ai_request_id).slice(0, 8)}</a>] as [string, ReactNode]] : []),
          ]} />
        </Panel>
        <Panel title="History">
          <DataTable rows={(t.events ?? []).map((e, i) => ({ ...e, k: `${i}` }))} rowKey={e => e.k} columns={[
            { key: 'at', label: 'When', render: e => fmtDateTime(e.at), sortValue: e => e.at }, { key: 'to_state', label: 'State', render: e => human(e.to_state) },
            { key: 'actor', label: 'By', render: e => <>{e.actor_sub} {e.actor_type !== 'user' ? <StatusPill tone="info">{e.actor_type}</StatusPill> : null}</> }]} />
        </Panel>
      </div>
      {t.type === 'protocol.appendix.review' && t.state === 'waiting_review' ? <ProposalReview task={t} onDone={() => task.reload()} /> : null}
      {t.type === 'arm.onboarding.plan' && t.outputs?.checklist ? <Panel title="Onboarding checklist">
        <DataTable rows={(t.outputs.checklist as { area: string; item: string }[]).map((c, i) => ({ ...c, k: `${i}` }))} rowKey={c => c.k}
          columns={[{ key: 'area', label: 'Area', render: c => human(c.area) }, { key: 'item', wrap: true, label: 'Item' }]} /></Panel> : null}
      {t.outputs?.decision ? <Panel title="Review decision"><DefinitionList items={[['Decision', <StatusPill tone={tone(t.outputs.decision)}>{human(t.outputs.decision)}</StatusPill>],
          ['Signature', <SignatureManifest signature={t.review_signature} empty={t.outputs.decided_by} />]]} />
        {t.outputs.edits?.length ? <DiffList sections={t.outputs.edits as SectionDiff[]} /> : null}</Panel> : null}
    </>
  );
}

function ProposalReview({ task, onDone }: { task: Task; onDone: () => void }) {
  const toast = useToast();
  const diff = useData<{ sections: SectionDiff[]; ai_generated?: AiProvenanceLike }>(`/v1/tasks/${task.id}/proposal-diff`);
  const [edited, setEdited] = useState<Content | null>(null);
  const [sign, setSign] = useState<null | 'accept' | 'edit' | 'reject'>(null);
  const proposal = (task.outputs?.proposal?.sections ?? {}) as Content;
  return (
    <>
      <Panel title={edited ? 'Edit the AI-generated proposal before accepting' : 'AI-generated proposal'}
        meta={<AiProvenance provenance={diff.data?.ai_generated ?? { agent: task.assignee }} />} actions={<>
        {edited ? <Button onClick={() => setEdited(null)}>Discard edits</Button> : <Button onClick={() => setEdited(structuredClone(proposal))}>Edit before accepting</Button>}
        {edited ? <Button variant="sign" onClick={() => setSign('edit')}>Accept with edits and sign</Button> : <Button variant="sign" onClick={() => setSign('accept')}>Accept and sign</Button>}
        <Button variant="danger" onClick={() => setSign('reject')}>Reject</Button></>}>
        {edited ? SECTIONS.filter(s => s.key in proposal).map(s => <div className="stack-sm" key={s.key}><strong>{s.m11} · {s.title}</strong>
          <SectionEditor sectionKey={s.key} editing value={edited[s.key]} onChange={v => setEdited({ ...edited, [s.key]: v })} /></div>)
          : diff.data ? <DiffList sections={diff.data.sections} /> : <Loading />}
      </Panel>
      {sign ? <SignDialog title={sign === 'reject' ? 'Reject the proposal' : 'Accept the proposal'} meaning="review"
        what={sign === 'reject' ? 'The proposal is rejected; the appendix draft stays unchanged.' : 'The sections are written into the appendix draft, which goes to review.'}
        confirmLabel={sign === 'reject' ? 'Sign and reject' : 'Sign and accept'} onClose={() => setSign(null)}
        onSign={async (password, reason) => {
          await api('POST', `/v1/tasks/${task.id}/review`, { reason, body: { decision: sign, password, ...(sign === 'edit' ? { sections: clean(edited) } : {}) } });
          setSign(null); toast('Decision signed'); onDone();
        }} /> : null}
    </>
  );
}
