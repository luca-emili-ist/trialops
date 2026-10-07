// TRO-010 Arms and TRO-011 Arm detail: lifecycle draft → approved → active → suspended → closed / graduated (M01-04).
import { useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, DefinitionList, ReasonDialog, SelectField, Modal, Steps, EmptyState, useToast } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { fmtDate, human, tone } from '../format.ts';

interface Arm { id: string; platform_id: string; code: string; name: string; sponsor: string | null; intervention_type: string; status: string; current_stage: string | null;
  has_prior_human_data: boolean | null; approved_any_indication: boolean | null; created_at: string;
  appendix_versions?: { id: string; version_label: string; status: string; created_at: string }[];
  stage_history?: { from_stage: string | null; to_stage: string; transitioned_at: string }[] }
interface Version { id: string; version_label: string; status: string; created_at: string }
interface Activation { id: string; site_number: string; site_name: string; site_id: string; status: string; next_step: string | null;
  qualified_at: string | null; contract_executed_at: string | null; irb_approved_at: string | null; training_done_at: string | null; green_light_at: string | null }

export function Arms() {
  const { platform, can } = useSession();
  const arms = useData<{ items: Arm[] }>(platform ? `/v1/platforms/${platform.id}/arms` : null);
  const master = useData<{ items: Version[] }>(platform ? `/v1/platforms/${platform.id}/protocol-versions` : null);
  const current = master.data?.items.filter(v => v.status !== 'superseded').at(-1);
  return (
    <>
      <PageHeader title="Arms & protocol" subtitle="Each arm inherits the Master Protocol and adds its own appendix."
        actions={<>{current ? <Button onClick={() => go(`/protocol/master/${current.id}`)}>Master Protocol v{current.version_label}</Button> : null}
          {can('platform_admin', 'platform_ops_manager') ? <Button variant="primary" onClick={() => go('/arms/new')}>Start new arm</Button> : null}</>} />
      {arms.error ? <ErrorNote error={arms.error} /> : !arms.data ? <Loading /> :
        <DataTable rows={arms.data.items} rowKey={a => a.id} onRowClick={a => go(`/arms/${a.id}`)} columns={[
          { key: 'code', label: 'Arm' }, { key: 'name', wrap: true, label: 'Intervention' }, { key: 'sponsor', label: 'Sponsor', render: a => a.sponsor ?? 'Platform' },
          { key: 'intervention_type', label: 'Type', render: a => human(a.intervention_type) },
          { key: 'status', label: 'Status', render: a => <StatusPill tone={tone(a.status)}>{human(a.status)}</StatusPill>, sortValue: a => a.status },
          { key: 'stage', label: 'Stage', render: a => human(a.current_stage), sortValue: a => a.current_stage },
          { key: 'created_at', label: 'Created', render: a => fmtDate(a.created_at), sortValue: a => a.created_at },
        ]} />}
    </>
  );
}

const NEXT: Record<string, string[]> = { draft: ['approved'], approved: ['active'], active: ['suspended', 'closed', 'graduated'], suspended: ['active', 'closed'] };
const STAGES = ['dose_finding', 'expansion', 'efficacy', 'confirmatory'];
const STEP_LABEL: Record<string, string> = { qualified: 'Qualified', contract_executed: 'Contract', irb_approved: 'IRB', training_done: 'Training', green_light: 'Green light' };

export function ArmDetail({ id }: { id: string }) {
  const s = useSession();
  const toast = useToast();
  const arm = useData<Arm>(`/v1/arms/${id}`);
  const acts = useData<{ items: Activation[] }>(`/v1/arms/${id}/site-activations`);
  const [to, setTo] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  if (arm.error) return <ErrorNote error={arm.error} />;
  if (!arm.data) return <Loading />;
  const a = arm.data;
  const ops = s.can('platform_admin', 'platform_ops_manager');
  const latest = a.appendix_versions?.at(-1);
  return (
    <>
      <PageHeader crumbs={<a href="#/arms">Arms & protocol</a>} title={`${a.code} — ${a.name}`} subtitle={a.sponsor ? `Sponsor: ${a.sponsor}` : 'Platform arm'}
        actions={ops ? <>
          {(NEXT[a.status] ?? []).map(n => <Button key={n} variant={n === 'approved' || n === 'active' ? 'primary' : 'secondary'} onClick={() => setTo(n)}>
            {n === 'approved' ? 'Approve arm' : n === 'active' ? 'Activate' : human(n).replace(/^./, c => c.toUpperCase())}</Button>)}
          {a.status === 'active' ? <Button onClick={() => setStage(a.current_stage ?? STAGES[0]!)}>Change stage</Button> : null}
        </> : undefined} />
      <div className="grid-2">
        <Panel title="Arm">
          <DefinitionList items={[
            ['Status', <StatusPill tone={tone(a.status)}>{human(a.status)}</StatusPill>], ['Stage', human(a.current_stage)],
            ['Intervention type', human(a.intervention_type)], ['Prior human data', a.has_prior_human_data === null ? '—' : a.has_prior_human_data ? 'Yes' : 'No'],
            ['Approved in any indication', a.approved_any_indication === null ? '—' : a.approved_any_indication ? 'Yes' : 'No'], ['Created', fmtDate(a.created_at)],
          ]} />
          {a.status === 'draft' && latest?.status !== 'approved' ? <p className="t-muted">The arm can be approved once its appendix is approved.</p> : null}
        </Panel>
        <Panel title="Appendix versions" actions={a.status === 'draft' && ops ? <Button onClick={() => go(`/arms/new?arm=${a.id}`)}>Continue onboarding</Button> : undefined}>
          <DataTable rows={a.appendix_versions ?? []} rowKey={v => v.id} onRowClick={v => go(`/protocol/appendix/${v.id}`)}
            empty={<EmptyState title="No appendix yet" />} columns={[
              { key: 'version_label', label: 'Version' },
              { key: 'status', label: 'Status', render: v => <StatusPill tone={tone(v.status)}>{human(v.status)}</StatusPill> },
              { key: 'created_at', label: 'Created', render: v => fmtDate(v.created_at), sortValue: v => v.created_at },
            ]} />
          {a.stage_history?.length ? <Steps steps={a.stage_history.map(h => ({ label: fmtDate(h.transitioned_at), value: human(h.to_stage), state: 'done' as const }))} /> : null}
        </Panel>
      </div>
      <Panel title="Site activation for this arm">
        {acts.error ? <ErrorNote error={acts.error} /> : !acts.data ? <Loading /> :
          <DataTable rows={acts.data.items} rowKey={x => x.id} onRowClick={x => go(`/sites/${x.site_id}`)}
            empty={<EmptyState title="No site is being activated for this arm yet" />} columns={[
              { key: 'site_number', label: 'Site' }, { key: 'site_name', wrap: true, label: 'Name' },
              { key: 'status', label: 'Status', render: x => <StatusPill tone={tone(x.status)}>{human(x.status)}</StatusPill> },
              { key: 'next', label: 'Next step', render: x => x.next_step ? STEP_LABEL[x.next_step] : 'Complete', sortValue: x => x.next_step },
              { key: 'green', label: 'Green light', render: x => fmtDate(x.green_light_at), sortValue: x => x.green_light_at },
            ]} />}
      </Panel>
      {to ? <ReasonDialog title={`Move ${a.code} to ${human(to)}`} confirmLabel="Confirm" onClose={() => setTo(null)}
        onConfirm={async reason => { await api('POST', `/v1/arms/${id}/status`, { reason, body: { to } }); setTo(null); toast(`${a.code} is now ${human(to)}`); arm.reload(); }} /> : null}
      {stage !== null ? <StageDialog current={stage} onClose={() => setStage(null)}
        onSave={async (next, reason) => { await api('POST', `/v1/arms/${id}/stage`, { reason, body: { to_stage: next } }); setStage(null); toast('Stage recorded'); arm.reload(); }} /> : null}
    </>
  );
}

function StageDialog({ current, onClose, onSave }: { current: string; onClose: () => void; onSave: (stage: string, reason: string) => Promise<void> }) {
  const [stage, setStage] = useState(current);
  const [step, setStep] = useState<'pick' | 'reason'>('pick');
  if (step === 'reason') return <ReasonDialog title={`Record stage ${human(stage)}`} confirmLabel="Record" onClose={onClose} onConfirm={r => onSave(stage, r)} />;
  return <Modal title="Change stage" onClose={onClose} actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => setStep('reason')}>Continue</Button></>}>
    <SelectField label="New stage" value={stage} onChange={e => setStage(e.target.value)} options={STAGES.map(x => ({ value: x, label: human(x) }))} />
  </Modal>;
}
