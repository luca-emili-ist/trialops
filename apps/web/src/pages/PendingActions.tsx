// TRO-053 Pending AI actions (AI-07, AI-08): agent tool calls the policy engine held for a person (mode CONFIRM, or the
// task type in suggestion-only). What the agent wants to do is shown before the decision (P4) in the AI material (P5,
// not signed yet), with the rules that held it and the signed Agent Decision Records (P10). A person whose roles may
// confirm the tool confirms (the tool then runs as that person) or rejects it, with a reason; the engine evaluates again
// with the registry in force. English only (platform administration and operations).
import { useState, type ReactNode } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, EmptyState, DefinitionList, DiffList, AiProvenance, AttentionList,
  ReasonDialog, SelectField, useToast, type SectionDiff, type Tone } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { fmtDateTime, human, short } from '../format.ts';

interface Pending { id: string; platform_id: string; arm_id: string | null; task_id: string | null; agent_id: string; tool: string; status: string;
  confirm_roles: string[]; can_confirm?: boolean; requested_at: string; requested_by: string; decided_by: string | null; decided_at: string | null;
  decision_reason: string | null; args: Record<string, unknown> & { ai_request_id?: string; plan?: { tasks?: PlanTask[]; checklist?: { area: string; item: string }[] } };
  result: Record<string, unknown> | null }
interface PlanTask { key: string; title: string; area: string; assignee_role: string; due_in_days?: number; gxp_impact?: boolean; site_number?: string }
interface Decision { id: string; seq: number | null; decided_at: string; decision: 'ALLOW' | 'REVIEW' | 'BLOCK'; rule_ids: string[]; rationale: string;
  actor_sub: string | null; actor_type: string | null; model: string | null; prompt_version: number | null; signature_status: string; record_sha256: string | null }

const STATUS_TONE: Record<string, Tone> = { pending: 'warn', executed: 'neutral', rejected: 'neutral', blocked: 'bad' };
const DECISION_TONE: Record<string, Tone> = { ALLOW: 'neutral', REVIEW: 'warn', BLOCK: 'bad' };

/** What the agent asks to do, as a diff of what would be added (P4). */
export function proposedChanges(p: Pending): SectionDiff[] {
  const tasks = p.args.plan?.tasks ?? [];
  if (tasks.length) return [{ section: 'tasks', change: 'added', items: tasks.map(t => ({ id: t.key, change: 'added',
    after: { title: `${t.title} · ${human(t.assignee_role)}${t.due_in_days !== undefined ? ` · due in ${t.due_in_days} days` : ''}${t.gxp_impact ? ' · GxP' : ''}` } })) }];
  const { ai_request_id: _a, task_id: _t, ...rest } = p.args;
  return Object.keys(rest).length ? [{ section: p.tool, change: 'added', after: rest }] : [];
}

export function PendingActions() {
  const s = useSession();
  const toast = useToast();
  const pid = s.platform?.id;
  const [status, setStatus] = useState('pending');
  const [open, setOpen] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ p: Pending; decision: 'confirm' | 'reject' } | null>(null);
  const list = useData<{ items: Pending[] }>(pid ? `/v1/ai/pending-actions?platform_id=${pid}&status=${status}` : null);
  const mine = (list.data?.items ?? []).filter(p => p.status === 'pending' && p.can_confirm);
  return (
    <>
      <PageHeader title="Pending AI actions" subtitle="Actions an agent asked to take and the policy engine held for a person: the tool is in CONFIRM mode, or the task type fell back to suggestion-only. Read what the agent wants to do, then confirm it (the tool runs in your name) or reject it."
        facts={[['Waiting for you', mine.length], ['Shown', list.data?.items.length ?? '—']]} />
      <Panel title="Waiting for your decision">
        <AttentionList clear="No agent action waits for a role you hold." items={mine.map(p => ({ key: p.id, severity: 'warn' as const,
          title: `${p.tool} · ${p.agent_id.replace(/^agent:/, '')}`, reason: `Requested ${fmtDateTime(p.requested_at)}; confirm roles: ${p.confirm_roles.map(human).join(', ')}`,
          onOpen: () => setOpen(p.id) }))} />
      </Panel>
      <div className="form-grid filters">
        <SelectField label="Status" value={status} onChange={e => { setStatus(e.target.value); setOpen(null); }} options={[
          { value: 'pending', label: 'Pending' }, { value: 'executed', label: 'Executed' }, { value: 'rejected', label: 'Rejected' },
          { value: 'blocked', label: 'Blocked' }, { value: 'all', label: 'All' }]} />
      </div>
      <Panel title="Agent actions" meta="Choose an action to read what the agent wants to do and why it was held.">
          {list.error ? <ErrorNote error={list.error} /> : !list.data ? <Loading /> :
            <DataTable rows={list.data.items} rowKey={p => p.id} onRowClick={p => setOpen(p.id)} selectedKey={open} label="Agent actions"
              empty={<EmptyState title="No agent actions with this status" />} columns={[
                { key: 'tool', label: 'Tool', render: p => <span className="t-mono">{p.tool}</span> },
                { key: 'agent', label: 'Agent', render: p => p.agent_id.replace(/^agent:/, ''), sortValue: p => p.agent_id },
                { key: 'status', label: 'Status', render: p => <StatusPill tone={STATUS_TONE[p.status] ?? 'neutral'}>{human(p.status)}</StatusPill>, sortValue: p => p.status },
                { key: 'requested_at', label: 'Requested', render: p => fmtDateTime(p.requested_at), sortValue: p => p.requested_at },
              ]} />}
      </Panel>
      {open ? <PendingDetail id={open} onClose={() => setOpen(null)} onDecide={(p, decision) => setDeciding({ p, decision })} /> : null}
      {deciding ? <ReasonDialog title={deciding.decision === 'confirm' ? `Confirm ${deciding.p.tool}` : `Reject ${deciding.p.tool}`}
        confirmLabel={deciding.decision === 'confirm' ? 'Confirm and run' : 'Reject'}
        description={deciding.decision === 'confirm'
          ? 'The policy engine evaluates the action again with the tool registry in force; if it is still allowed, the tool runs in your name. A signed decision record keeps your reason.'
          : 'Nothing is changed. A signed decision record keeps your reason.'}
        onClose={() => setDeciding(null)} onConfirm={async reason => {
          const r = await api<{ decision: string; pending_action: { status: string } }>('POST', `/v1/ai/pending-actions/${deciding.p.id}/decide`,
            { reason, body: { decision: deciding.decision } });
          setDeciding(null); toast(`Decision recorded: ${r.decision} · ${human(r.pending_action.status)}`); list.reload();
        }} /> : null}
    </>
  );
}

function PendingDetail({ id, onClose, onDecide }: { id: string; onClose: () => void; onDecide: (p: Pending, d: 'confirm' | 'reject') => void }) {
  const s = useSession();
  const d = useData<Pending & { decisions: Decision[] }>(`/v1/ai/pending-actions/${id}`);
  if (d.error) return <ErrorNote error={d.error} />;
  if (!d.data) return <Loading />;
  const p = d.data;
  const canDecide = p.status === 'pending' && p.confirm_roles.some(r => s.me?.roles.includes(r));
  const model = p.decisions.find(x => x.model)?.model ?? null;
  const facts: [string, ReactNode][] = [
    ['Status', <StatusPill tone={STATUS_TONE[p.status] ?? 'neutral'}>{human(p.status)}</StatusPill>],
    ['Agent', p.agent_id.replace(/^agent:/, '')], ['Tool', <span className="t-mono">{p.tool}</span>],
    ['Confirmed by', p.confirm_roles.map(human).join(', ')],
    ...(p.task_id ? [['Task', <a href={`#/tasks/${p.task_id}`}>{short(p.task_id)}</a>] as [string, ReactNode]] : []),
    ...(p.decided_by ? [['Decided', `${p.decided_by} · ${fmtDateTime(p.decided_at)}`] as [string, ReactNode], ['Reason', p.decision_reason ?? '—'] as [string, ReactNode]] : []),
  ];
  return (
    <div className="stack">
      <Panel ai={p.status === 'pending'} title={`What the agent wants to do · ${p.tool}`} actions={<Button variant="ghost" onClick={onClose}>Close</Button>}
        meta={<AiProvenance provenance={{ agent: p.agent_id, model, ai_request_id: p.args.ai_request_id ?? null,
          reviewed_by: p.decided_by, decision: p.status === 'executed' ? 'accepted' : null }} />}>
        <DefinitionList items={facts} />
        <DiffList sections={proposedChanges(p)} />
        {canDecide ? <div className="row">
          <Button variant="primary" onClick={() => onDecide(p, 'confirm')}>Confirm…</Button>
          <Button variant="danger" onClick={() => onDecide(p, 'reject')}>Reject…</Button>
        </div> : p.status === 'pending' ? <p className="t-muted">Only a person with the role {p.confirm_roles.map(human).join(' or ')} decides this action.</p> : null}
      </Panel>
      <Panel title="Agent Decision Records" meta="Signed (Ed25519) and chained by the policy engine; the chain is verified from the audit pages.">
        <DataTable rows={p.decisions} rowKey={x => x.id} label="Agent Decision Records" empty={<EmptyState title="No decision record" />} columns={[
          { key: 'seq', label: 'Seq', align: 'right', render: x => x.seq ?? '—', sortValue: x => x.seq },
          { key: 'decided_at', label: 'When', render: x => fmtDateTime(x.decided_at), sortValue: x => x.decided_at },
          { key: 'decision', label: 'Decision', render: x => <StatusPill tone={DECISION_TONE[x.decision] ?? 'neutral'}>{x.decision}</StatusPill>, sortValue: x => x.decision },
          { key: 'rules', label: 'Rules applied', wrap: true, render: x => <span className="t-mono">{x.rule_ids.join(', ')}</span> },
          { key: 'actor', label: 'By', render: x => `${x.actor_sub ?? '—'}${x.actor_type && x.actor_type !== 'user' ? ` (${x.actor_type})` : ''}` },
          { key: 'sig', label: 'Signature', render: x => x.signature_status === 'signed' ? <span className="t-mono">{short(x.record_sha256)}</span>
            : <StatusPill tone="bad">{human(x.signature_status)}</StatusPill> },
        ]} />
      </Panel>
    </div>
  );
}
