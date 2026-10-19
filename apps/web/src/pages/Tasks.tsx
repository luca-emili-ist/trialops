// TRO-030 Task inbox and TRO-031 Task detail: state history, agent run, review of agent proposals (AI-05, APP-TK-04).
// Site-facing: localised in English and Japanese (NFR-07). Content of records (titles, protocol text) stays as recorded.
import { useState, type ReactNode } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, DefinitionList, SelectField, SignDialog, DiffList, EmptyState, useToast,
  SignatureManifest, AiProvenance, useT, type SectionDiff, type SignatureLike, type AiProvenanceLike } from '@trialops/shell';
import { api, runJob } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { fmtDate, fmtDateTime, human, tone } from '../format.ts';
import { SECTIONS, SectionEditor, clean, type Content } from '../components/ProtocolSections.tsx';

interface Task { id: string; type: string; title: string; arm_code: string | null; assignee_kind: string; assignee: string; state: string; gxp_impact: boolean;
  priority: string; due_at: string | null; created_at: string; inputs?: Content; outputs?: Content | null; review_signature?: SignatureLike | null; events?: { from_state: string | null; to_state: string; actor_sub: string; actor_type: string; at: string }[] }

export function Tasks() {
  const { platform } = useSession();
  const t = useT();
  const [mine, setMine] = useState('true');
  const [state, setState] = useState('open');
  const tasks = useData<{ items: Task[] }>(platform ? `/v1/platforms/${platform.id}/tasks?mine=${mine}&state=${state}` : null);
  return (
    <>
      <PageHeader title={t('Tasks')} subtitle={t("Work assigned to people, roles, agents and apps. GxP tasks done by an agent wait for a person's review and signature.")} />
      <div className="form-grid filters">
        <SelectField label={t('Assigned to')} value={mine} onChange={e => setMine(e.target.value)} options={[{ value: 'true', label: t('Me and my roles') }, { value: 'false', label: t('Everyone') }]} />
        <SelectField label={t('State')} value={state} onChange={e => setState(e.target.value)} options={[{ value: 'open', label: t('Open') }, { value: 'all', label: t('All') }]} />
      </div>
      {tasks.error ? <ErrorNote error={tasks.error} /> : !tasks.data ? <Loading /> :
        <DataTable rows={tasks.data.items} rowKey={r => r.id} onRowClick={r => go(`/tasks/${r.id}`)} label={t('Tasks')}
          empty={<EmptyState title={t('No tasks here')}>{t('Nothing is waiting for you.')}</EmptyState>} columns={[
            { key: 'title', wrap: true, label: t('Task') }, { key: 'arm_code', label: t('Arm'), render: r => r.arm_code ?? '—' },
            { key: 'assignee', label: t('Assigned to'), render: r => r.assignee_kind === 'agent' ? `${t('Agent')} · ${r.assignee.replace('agent:', '')}` : t(human(r.assignee)) },
            { key: 'gxp', label: 'GxP', render: r => r.gxp_impact ? <StatusPill tone="info">GxP</StatusPill> : '—', sortValue: r => (r.gxp_impact ? 1 : 0) },
            { key: 'state', label: t('State'), render: r => <StatusPill tone={tone(r.state)}>{t(human(r.state))}</StatusPill>, sortValue: r => r.state },
            { key: 'due_at', label: t('Due'), render: r => fmtDate(r.due_at), sortValue: r => r.due_at },
          ]} />}
    </>
  );
}

export function TaskDetail({ id }: { id: string }) {
  const s = useSession();
  const tr = useT();
  const toast = useToast();
  const task = useData<Task>(`/v1/tasks/${id}`);
  const [busy, setBusy] = useState(false);
  if (task.error) return <ErrorNote error={task.error} />;
  if (!task.data) return <Loading />;
  const t = task.data;
  const runnable = t.assignee_kind === 'agent' && ['assigned', 'in_progress'].includes(t.state) && s.can('platform_admin', 'platform_ops_manager');
  return (
    <>
      <PageHeader crumbs={<a href="#/tasks">{tr('Tasks')}</a>} title={t.title}
        facts={[[tr('State'), tr(human(t.state))], [tr('Arm'), t.arm_code ?? '—'], [tr('Assigned to'), t.assignee_kind === 'agent' ? t.assignee.replace('agent:', '') : tr(human(t.assignee))],
          [tr('Due'), fmtDate(t.due_at)], ...(t.gxp_impact ? [['GxP', tr('signed by a person')] as [string, string]] : [])]}
        actions={runnable ? <Button variant="primary" disabled={busy} onClick={() => { setBusy(true); runJob<{ outcome: string; error?: string }>('POST', `/v1/tasks/${id}/run-agent`)
          .then(r => toast(r.outcome === 'success' ? tr('Agent finished') : `${tr('Agent')}: ${r.outcome} ${r.error ?? ''}`, r.outcome !== 'success'), e => toast((e as Error).message, true))
          .finally(() => { setBusy(false); task.reload(); }); }}>{busy ? tr('Agent working…') : tr('Run the agent')}</Button> : undefined} />
      <div className="grid-2">
        <Panel title={tr('Task')}>
          <DefinitionList items={[
            [tr('State'), <StatusPill tone={tone(t.state)}>{tr(human(t.state))}</StatusPill>], [tr('Type'), <span className="t-mono">{t.type}</span>],
            [tr('Assigned to'), t.assignee_kind === 'agent' ? `${tr('Agent')} ${t.assignee}` : tr(human(t.assignee))], [tr('Arm'), t.arm_code ?? '—'],
            [tr('GxP impact'), t.gxp_impact ? tr('Yes — a person signs the outcome') : tr('No')], [tr('Due'), fmtDate(t.due_at)],
            ...(t.outputs?.ai_request_id ? [[tr('AI request'), <a href="#/ai" className="t-mono">{String(t.outputs.ai_request_id).slice(0, 8)}</a>] as [string, ReactNode]] : []),
          ]} />
        </Panel>
        <Panel title={tr('History')}>
          <DataTable label={tr('History')} rows={(t.events ?? []).map((e, i) => ({ ...e, k: `${i}` }))} rowKey={e => e.k} columns={[
            { key: 'at', label: tr('When'), render: e => fmtDateTime(e.at), sortValue: e => e.at }, { key: 'to_state', label: tr('State'), render: e => tr(human(e.to_state)) },
            { key: 'actor', label: tr('By'), render: e => <>{e.actor_sub} {e.actor_type !== 'user' ? <StatusPill tone="info">{tr(e.actor_type)}</StatusPill> : null}</> }]} />
        </Panel>
      </div>
      {t.type === 'protocol.appendix.review' && t.state === 'waiting_review' ? <ProposalReview task={t} onDone={() => task.reload()} /> : null}
      {t.type === 'arm.onboarding.plan' && t.outputs?.checklist ? <Panel title={tr('Onboarding checklist')}>
        <DataTable label={tr('Onboarding checklist')} rows={(t.outputs.checklist as { area: string; item: string }[]).map((c, i) => ({ ...c, k: `${i}` }))} rowKey={c => c.k}
          columns={[{ key: 'area', label: tr('Area'), render: c => tr(human(c.area)) }, { key: 'item', wrap: true, label: tr('Item') }]} /></Panel> : null}
      {t.outputs?.decision ? <Panel title={tr('Review decision')}><DefinitionList items={[[tr('Decision'), <StatusPill tone={tone(t.outputs.decision)}>{tr(human(t.outputs.decision))}</StatusPill>],
          [tr('Signature'), <SignatureManifest signature={t.review_signature} empty={t.outputs.decided_by} />]]} />
        {t.outputs.edits?.length ? <DiffList sections={t.outputs.edits as SectionDiff[]} /> : null}</Panel> : null}
    </>
  );
}

function ProposalReview({ task, onDone }: { task: Task; onDone: () => void }) {
  const toast = useToast();
  const t = useT();
  const diff = useData<{ sections: SectionDiff[]; ai_generated?: AiProvenanceLike }>(`/v1/tasks/${task.id}/proposal-diff`);
  const [edited, setEdited] = useState<Content | null>(null);
  const [sign, setSign] = useState<null | 'accept' | 'edit' | 'reject'>(null);
  const proposal = (task.outputs?.proposal?.sections ?? {}) as Content;
  return (
    <>
      <Panel ai title={edited ? t('Edit the AI-generated proposal before accepting') : t('AI-generated proposal')}
        meta={<AiProvenance provenance={diff.data?.ai_generated ?? { agent: task.assignee }} />} actions={<>
        {edited ? <Button onClick={() => setEdited(null)}>{t('Discard edits')}</Button> : <Button onClick={() => setEdited(structuredClone(proposal))}>{t('Edit before accepting')}</Button>}
        {edited ? <Button variant="sign" onClick={() => setSign('edit')}>{t('Accept with edits and sign')}</Button> : <Button variant="sign" onClick={() => setSign('accept')}>{t('Accept and sign')}</Button>}
        <Button variant="danger" onClick={() => setSign('reject')}>{t('Reject')}</Button></>}>
        {edited ? SECTIONS.filter(s => s.key in proposal).map(s => <div className="stack-sm" key={s.key}><strong>{s.m11} · {s.title}</strong>
          <SectionEditor sectionKey={s.key} editing value={edited[s.key]} onChange={v => setEdited({ ...edited, [s.key]: v })} /></div>)
          : diff.data ? <DiffList sections={diff.data.sections} /> : <Loading />}
      </Panel>
      {sign ? <SignDialog title={sign === 'reject' ? t('Reject the proposal') : t('Accept the proposal')} meaning="review"
        what={sign === 'reject' ? t('The proposal is rejected; the appendix draft stays unchanged.') : t('The sections are written into the appendix draft, which goes to review.')}
        confirmLabel={sign === 'reject' ? t('Sign and reject') : t('Sign and accept')} onClose={() => setSign(null)}
        onSign={async (password, reason, totp) => {
          await api('POST', `/v1/tasks/${task.id}/review`, { reason, body: { decision: sign, password, totp, ...(sign === 'edit' ? { sections: clean(edited) } : {}) } });
          setSign(null); toast(t('Decision signed')); onDone();
        }} /> : null}
    </>
  );
}
