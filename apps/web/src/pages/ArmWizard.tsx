// TRO-012 New-arm wizard (M01-02): arm details → agents prepare (Protocol author, Onboarding planner) → a person reviews
// the diff with sources and signs → ready for submission. Resumable through #/arms/new?arm=<id>.
import { useEffect, useState, type ReactNode } from 'react';
import { PageHeader, Panel, Button, TextField, SelectField, Field, Textarea, ProcessMap, DataTable, DiffList, StatusPill, SignDialog,
  Loading, ErrorNote, DefinitionList, EmptyState, useToast, AiProvenance, type SectionDiff, type AiProvenanceLike } from '@trialops/shell';
import { api, runJob } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { human, tone, fmtDateTime } from '../format.ts';

interface Task { id: string; type: string; title: string; assignee: string; assignee_kind: string; state: string; arm_id: string; created_at: string; updated_at: string }
interface Doc { ref: string; title: string; text: string }
interface Diff { appendix_version_id: string; sections: SectionDiff[]; sources: { section: string; item_id: string; ref: string; quote: string }[];
  consistency_checks: { check: string; result: string; detail: string }[]; ai_generated?: AiProvenanceLike }

const EXAMPLE_DOCS: Doc[] = [
  { ref: 'SPONSOR-BRIEF-D', title: 'Sponsor briefing document (synthetic)', text: 'MRD-12 is an oral small molecule. The recommended phase 2 dose is 40 mg once daily. The proposed primary endpoint is the change in functional score at 24 weeks. Trough sampling at weeks 4, 12 and 24 will support exposure-response analysis.' },
  { ref: 'IB-MRD-12', title: 'Investigator brochure extract (synthetic)', text: 'MRD-12 is a sensitive CYP3A4 substrate. A dose-dependent QTc prolongation was observed above 80 mg. No hepatic signal in phase 1.' },
];
const armFromHash = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('arm');

export function ArmWizard() {
  const [armId, setArmId] = useState<string | null>(armFromHash());
  useEffect(() => { const on = () => setArmId(armFromHash()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  return armId ? <Progress armId={armId} /> : <Details onCreated={id => go(`/arms/new?arm=${id}`)} />;
}

function Details({ onCreated }: { onCreated: (armId: string) => void }) {
  const { platform, can } = useSession();
  const toast = useToast();
  const sponsors = useData<{ items: { id: string; name: string; is_small_business: boolean }[] }>('/v1/organizations?type=sponsor');
  const [f, setF] = useState({ code: 'ARM-D', name: 'MRD-12 oral small molecule', sponsor_org_id: '', intervention_type: 'drug', has_prior_human_data: 'true', approved_any_indication: 'false' });
  const [docs, setDocs] = useState<Doc[]>([]);
  const [busy, setBusy] = useState(false);
  if (!can('platform_admin', 'platform_ops_manager')) return <EmptyState title="Only platform operations can start a new arm" />;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ arm: { id: string } }>('POST', `/v1/platforms/${platform!.id}/arm-wizard`, { body: {
        arm: { code: f.code.trim(), name: f.name.trim(), intervention_type: f.intervention_type, ...(f.sponsor_org_id ? { sponsor_org_id: f.sponsor_org_id } : {}),
          has_prior_human_data: f.has_prior_human_data === 'true', approved_any_indication: f.approved_any_indication === 'true' },
        sponsor_documents: docs.filter(d => d.ref && d.text) } });
      toast(`${f.code} created as draft`);
      onCreated(r.arm.id);
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <>
      <PageHeader crumbs={<a href="#/arms">Arms & protocol</a>} title="Start a new arm"
        subtitle="Enter the sponsor's arm. The Protocol author agent drafts the appendix from the Master Protocol and the sponsor documents; the Onboarding planner creates the tasks. Nothing is approved without a signature." />
      <WizardSteps current={0} />
      <Panel title="Arm">
        <div className="form-grid">
          <TextField label="Arm code" value={f.code} onChange={set('code')} hint="Capital letters, digits and dashes" />
          <TextField label="Intervention" value={f.name} onChange={set('name')} />
          <SelectField label="Sponsor" value={f.sponsor_org_id} onChange={set('sponsor_org_id')}
            options={[{ value: '', label: '— choose —' }, ...(sponsors.data?.items ?? []).map(o => ({ value: o.id, label: `${o.name}${o.is_small_business ? ' (small business)' : ''}` }))]} />
          <SelectField label="Intervention type" value={f.intervention_type} onChange={set('intervention_type')} options={['drug', 'biologic'].map(x => ({ value: x, label: x }))} />
          <SelectField label="Prior human data" value={f.has_prior_human_data} onChange={set('has_prior_human_data')} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} />
          <SelectField label="Approved in any indication" value={f.approved_any_indication} onChange={set('approved_any_indication')} options={[{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }]} />
        </div>
      </Panel>
      <Panel title="Sponsor documents" actions={<>{!docs.length ? <Button onClick={() => setDocs(EXAMPLE_DOCS)}>Use the synthetic example</Button> : null}
        <Button onClick={() => setDocs([...docs, { ref: '', title: '', text: '' }])}>Add document</Button></>}
        meta="Paste the relevant text. Every statement the agent proposes must cite one of these documents.">
        {!docs.length ? <EmptyState title="No documents yet">Add the sponsor briefing and the investigator brochure, or use the synthetic example.</EmptyState> :
          docs.map((d, i) => (
            <div className="stack-sm" key={i}>
              <div className="form-grid">
                <TextField label="Reference" value={d.ref} onChange={e => setDocs(docs.map((x, j) => j === i ? { ...x, ref: e.target.value } : x))} />
                <TextField label="Title" value={d.title} onChange={e => setDocs(docs.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
              </div>
              <Field label="Text"><Textarea aria-label={`Document ${i + 1} text`} value={d.text} onChange={e => setDocs(docs.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} /></Field>
            </div>))}
      </Panel>
      <div className="row"><Button variant="primary" disabled={busy || !f.code || !f.name || !f.sponsor_org_id} onClick={submit}>{busy ? 'Creating…' : 'Create draft arm and assign the agents'}</Button></div>
    </>
  );
}

function WizardSteps({ current }: { current: number }) {
  const steps = [
    { key: 'details', label: 'Arm details', actor: 'person' as const, autonomy: 'Done by platform operations' },
    { key: 'agents', label: 'Agents prepare', actor: 'agent' as const, autonomy: 'Agents draft, nothing changes yet' },
    { key: 'review', label: 'Review and sign', actor: 'person' as const, gate: true, autonomy: 'A person accepts or rejects' },
    { key: 'ready', label: 'Ready for submission', actor: 'person' as const, gate: true, autonomy: 'Approval needs another person' },
  ];
  return <ProcessMap label="Onboarding of the arm" steps={steps.map((s, i) => ({ ...s, state: i < current ? 'done' : i === current ? 'current' : 'todo',
    status: i < current ? 'done' : i === current ? (s.actor === 'agent' ? 'agents' : 'now') : undefined }))} />;
}

function Progress({ armId }: { armId: string }) {
  const { platform } = useSession();
  const toast = useToast();
  const arm = useData<{ code: string; name: string; status: string; created_at: string }>(`/v1/arms/${armId}`);
  const tasks = useData<{ items: Task[] }>(platform ? `/v1/platforms/${platform.id}/tasks?arm_id=${armId}&state=all` : null);
  const [running, setRunning] = useState(false);
  if (arm.error) return <ErrorNote error={arm.error} />;
  if (!arm.data || !tasks.data) return <Loading />;
  const author = tasks.data.items.find(t => t.assignee === 'agent:protocol-author');
  const planner = tasks.data.items.find(t => t.assignee === 'agent:onboarding-planner');
  const created = tasks.data.items.filter(t => t.assignee_kind === 'role');
  const stage = !author ? 0 : ['completed', 'rejected'].includes(author.state) ? 3 : author.state === 'waiting_review' ? 2 : 1;
  const runAgents = async () => {
    setRunning(true);
    for (const t of [author, planner]) {
      if (!t || !['assigned', 'in_progress'].includes(t.state)) continue;
      try {
        const r = await runJob<{ outcome: string; error?: string }>('POST', `/v1/tasks/${t.id}/run-agent`, { onStatus: () => tasks.reload() });
        if (r.outcome !== 'success') toast(`${t.assignee}: ${r.outcome}${r.error ? ` — ${r.error}` : ''}`, true);
      } catch (e) { toast((e as Error).message, true); }
    }
    setRunning(false); tasks.reload();
  };
  return (
    <>
      <PageHeader crumbs={<><a href="#/arms">Arms & protocol</a> · <a href={`#/arms/${armId}`}>{arm.data.code}</a></>} title={`Onboarding ${arm.data.code} — ${arm.data.name}`}
        subtitle={`Arm created ${fmtDateTime(arm.data.created_at)}. Status: ${human(arm.data.status)}.`} />
      <WizardSteps current={stage} />
      <Panel title="Agent tasks" actions={stage === 1 || (planner && planner.state === 'assigned') ? <Button variant="primary" disabled={running} onClick={runAgents}>{running ? 'Agents working…' : 'Run the agents'}</Button> : undefined}
        meta="Agents act under their own identity, limited to this arm, and every model call is recorded in the AI ledger.">
        <DataTable rows={[author, planner].filter(Boolean) as Task[]} rowKey={t => t.id} onRowClick={t => go(`/tasks/${t.id}`)} columns={[
          { key: 'assignee', label: 'Agent', render: t => t.assignee.replace('agent:', '').replace('-', ' ') },
          { key: 'title', wrap: true, label: 'Task' },
          { key: 'state', label: 'State', render: t => <StatusPill tone={tone(t.state)}>{human(t.state)}</StatusPill> },
          { key: 'updated_at', label: 'Updated', render: t => fmtDateTime(t.updated_at) },
        ]} />
      </Panel>
      {stage === 2 && author ? <Review task={author} onDone={() => tasks.reload()} /> : null}
      {stage === 3 && author ? <Done arm={arm.data} author={author} created={created.length} armId={armId} /> : null}
      {created.length ? <Panel title={`Onboarding tasks created by the planner (${created.length})`}>
        <DataTable rows={created} rowKey={t => t.id} onRowClick={t => go(`/tasks/${t.id}`)} columns={[
          { key: 'title', wrap: true, label: 'Task' }, { key: 'assignee', label: 'Assigned to', render: t => human(t.assignee) },
          { key: 'state', label: 'State', render: t => <StatusPill tone={tone(t.state)}>{human(t.state)}</StatusPill> },
        ]} /></Panel> : null}
    </>
  );
}

function Review({ task, onDone }: { task: Task; onDone: () => void }) {
  const toast = useToast();
  const diff = useData<Diff>(`/v1/tasks/${task.id}/proposal-diff`);
  const [sign, setSign] = useState<null | 'accept' | 'reject'>(null);
  if (diff.error) return <ErrorNote error={diff.error} />;
  if (!diff.data) return <Loading what="Loading the proposal" />;
  const d = diff.data;
  return (
    <>
      <div className="grid-2">
        <Panel ai title="AI-generated appendix proposal — changes to the draft" meta="Proposal by the Protocol author agent. It changes nothing until a person accepts it with a signature.">
          <AiProvenance provenance={d.ai_generated ?? { agent: task.assignee }} />
          <DiffList sections={d.sections} />
        </Panel>
        <div className="stack">
          <Panel title="Consistency with the Master Protocol">
            <DataTable rows={d.consistency_checks.map((c, i) => ({ ...c, k: `${i}` }))} rowKey={c => c.k} columns={[
              { key: 'check', wrap: true, label: 'Check' },
              { key: 'result', label: 'Result', render: c => <StatusPill tone={c.result === 'pass' ? 'ok' : 'warn'}>{c.result === 'pass' ? 'Pass' : 'Warning'}</StatusPill> },
              { key: 'detail', wrap: true, label: 'Detail' }]} empty={<EmptyState title="No checks reported" />} />
          </Panel>
          <Panel title="Sources cited">
            <DataTable rows={d.sources.map((s, i) => ({ ...s, k: `${i}` }))} rowKey={s => s.k} columns={[
              { key: 'item_id', label: 'Item' }, { key: 'ref', label: 'Document' }, { key: 'quote', wrap: true, label: 'Quote' }]} empty={<EmptyState title="No sources cited" />} />
          </Panel>
        </div>
      </div>
      <div className="row">
        <Button variant="sign" onClick={() => setSign('accept')}>Accept and sign</Button>
        <Button onClick={() => go(`/tasks/${task.id}`)}>Edit before accepting</Button>
        <Button variant="danger" onClick={() => setSign('reject')}>Reject</Button>
      </div>
      {sign ? <SignDialog title={sign === 'accept' ? 'Accept the proposed appendix' : 'Reject the proposal'} meaning="review"
        what={sign === 'accept' ? 'The proposed sections are written into the appendix draft, which goes to review. Approval needs another person.' : 'The proposal is rejected and the appendix draft stays unchanged.'}
        confirmLabel={sign === 'accept' ? 'Sign and accept' : 'Sign and reject'}
        reasonDefault={sign === 'accept' ? 'Proposal checked against the sponsor documents' : ''} onClose={() => setSign(null)}
        onSign={async (password, reason, totp) => {
          await api('POST', `/v1/tasks/${task.id}/review`, { reason, body: { decision: sign, password, totp } });
          setSign(null); toast(sign === 'accept' ? 'Proposal accepted and signed' : 'Proposal rejected'); onDone();
        }} /> : null}
    </>
  );
}

function Done({ arm, author, created, armId }: { arm: { code: string; created_at: string }; author: Task; created: number; armId: string }) {
  const versions = useData<{ items: { id: string; status: string; version_label: string; ai_provenance: AiProvenanceLike | null }[] }>(`/v1/arms/${armId}/appendix-versions`);
  const v = versions.data?.items.at(-1);
  const hours = (Date.parse(author.updated_at) - Date.parse(arm.created_at)) / 36e5;
  return (
    <Panel title={author.state === 'completed' ? `${arm.code} is ready for submission` : 'Proposal rejected'}>
      <DefinitionList items={[
        ['Appendix', v ? <a href={`#/protocol/appendix/${v.id}`}>v{v.version_label} — {human(v.status)}</a> : '—'],
        ...(v?.ai_provenance ? [['Content origin', <AiProvenance provenance={v.ai_provenance} />] as [string, ReactNode]] : []),
        ['Tasks created', `${created} assigned to regulatory, contracts, sites, supply, data management and training`],
        ['Time from arm creation to signed review', hours < 1 ? `${Math.max(1, Math.round(hours * 60))} minutes` : `${hours.toFixed(1)} hours`],
        ['Next', 'A regulatory lead or platform admin who did not author the appendix approves it with a signature; then the arm can be approved.'],
      ]} />
    </Panel>
  );
}
