// TRO-020 Site network and TRO-021 Site detail: registry (M02-01) and per-arm activation workflow (M02-03).
import { useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, DefinitionList, Steps, ReasonDialog, Modal, TextField, SelectField, EmptyState, useToast } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { fmtDate, human, tone } from '../format.ts';

interface SiteRow { id: string; site_number: string; name: string; country: string; declared_capacity_per_month: string | null; status: string; pi_name: string | null;
  certifications: number; competing_trials: number; identified: number; randomized: number; arms_activated: number }
const STEPS = ['qualified', 'contract_executed', 'irb_approved', 'training_done', 'green_light'] as const;
const STEP_LABEL: Record<string, string> = { qualified: 'Qualification', contract_executed: 'Contract', irb_approved: 'IRB', training_done: 'Training', green_light: 'Green light' };

export function Sites() {
  const { platform, can } = useSession();
  const sites = useData<{ items: SiteRow[] }>(platform ? `/v1/platforms/${platform.id}/sites` : null);
  const [adding, setAdding] = useState(false);
  const avg = sites.data?.items.length ? sites.data.items.reduce((a, s) => a + s.randomized, 0) / sites.data.items.length : 0;
  return (
    <>
      <PageHeader title="Site network" subtitle="Registry of sites, investigators, certifications and competing trials, with enrollment per site."
        actions={can('platform_admin', 'platform_ops_manager', 'ctm') ? <Button variant="primary" onClick={() => setAdding(true)}>Register site</Button> : undefined} />
      {sites.error ? <ErrorNote error={sites.error} /> : !sites.data ? <Loading /> :
        <DataTable rows={sites.data.items} rowKey={s => s.id} onRowClick={s => go(`/sites/${s.id}`)} columns={[
          { key: 'site_number', label: 'Site' }, { key: 'name', wrap: true, label: 'Name' }, { key: 'pi_name', label: 'Principal investigator', render: s => s.pi_name ?? '—' },
          { key: 'cap', label: 'Capacity / month', align: 'right', render: s => s.declared_capacity_per_month ?? '—', sortValue: s => Number(s.declared_capacity_per_month) },
          { key: 'identified', label: 'Identified', align: 'right', sortValue: s => s.identified, render: s => s.identified },
          { key: 'randomized', label: 'Randomized', align: 'right', sortValue: s => s.randomized,
            render: s => <>{s.randomized} {s.randomized < avg * 0.5 ? <StatusPill tone="bad">Below half of average</StatusPill> : null}</> },
          { key: 'arms_activated', label: 'Arms active', align: 'right', render: s => s.arms_activated, sortValue: s => s.arms_activated },
          { key: 'competing_trials', label: 'Competing trials', align: 'right', render: s => s.competing_trials, sortValue: s => s.competing_trials },
          { key: 'status', label: 'Status', render: s => <StatusPill tone={tone(s.status)}>{human(s.status)}</StatusPill>, sortValue: s => s.status },
        ]} />}
      {adding ? <RegisterSite onClose={() => setAdding(false)} onDone={() => { setAdding(false); sites.reload(); }} /> : null}
    </>
  );
}

function RegisterSite({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { platform } = useSession();
  const toast = useToast();
  const orgs = useData<{ items: { id: string; name: string }[] }>('/v1/organizations?type=site');
  const [f, setF] = useState({ org_id: '', site_number: '', country: 'US', cap: '' });
  return <Modal title="Register a candidate site" onClose={onClose} actions={<><Button onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={!f.org_id || !f.site_number} onClick={() => api('POST', `/v1/platforms/${platform!.id}/sites`, { body: {
      org_id: f.org_id, site_number: f.site_number, country: f.country, ...(f.cap ? { declared_capacity_per_month: Number(f.cap) } : {}) } })
      .then(() => { toast('Site registered'); onDone(); }, e => toast((e as Error).message, true))}>Register</Button></>}>
    <SelectField label="Organization" value={f.org_id} onChange={e => setF({ ...f, org_id: e.target.value })}
      options={[{ value: '', label: '— choose —' }, ...(orgs.data?.items ?? []).map(o => ({ value: o.id, label: o.name }))]} />
    <div className="form-grid">
      <TextField label="Site number" value={f.site_number} onChange={e => setF({ ...f, site_number: e.target.value })} />
      <TextField label="Country (ISO)" value={f.country} maxLength={2} onChange={e => setF({ ...f, country: e.target.value.toUpperCase() })} />
      <TextField label="Capacity per month" type="number" value={f.cap} onChange={e => setF({ ...f, cap: e.target.value })} />
    </div>
  </Modal>;
}

interface SiteDetailData { id: string; site_number: string; name: string; country: string; declared_capacity_per_month: string | null; status: string;
  investigators: { id: string; full_name: string; investigator_role: string; specialty: string | null; gcp_training_valid_until: string | null }[];
  certifications: { id: string; kind: string; issuer: string | null; valid_until: string | null; status: string }[];
  concurrent_trials: { id: string; title: string; registry_id: string | null; competes_for_population: boolean }[];
  activations: ({ id: string; arm_code: string; status: string; next_step: string | null } & Record<string, string | null>)[] }

export function SiteDetail({ id }: { id: string }) {
  const s = useSession();
  const toast = useToast();
  const site = useData<SiteDetailData>(`/v1/sites/${id}`);
  const [step, setStep] = useState<{ act: string; step: string; arm: string } | null>(null);
  if (site.error) return <ErrorNote error={site.error} />;
  if (!site.data) return <Loading />;
  const d = site.data;
  const editor = s.can('platform_admin', 'platform_ops_manager', 'ctm');
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHeader crumbs={<a href="#/sites">Site network</a>} title={`Site ${d.site_number} — ${d.name}`} subtitle={`${d.country} · capacity ${d.declared_capacity_per_month ?? '—'} subjects per month`} />
      <Panel title="Activation per arm" meta="Each step is dated in order; the green light needs all previous steps and an active arm.">
        {!d.activations.length ? <EmptyState title="This site is not being activated for any arm" /> : d.activations.map(a => (
          <div className="stack-sm" key={a.id}>
            <div className="row"><strong>{a.arm_code}</strong><StatusPill tone={tone(a.status)}>{human(a.status)}</StatusPill>
              {a.next_step && editor ? <Button variant="primary" onClick={() => setStep({ act: a.id, step: a.next_step!, arm: a.arm_code })}>Record {STEP_LABEL[a.next_step]}</Button> : null}</div>
            <Steps steps={STEPS.map(k => ({ label: STEP_LABEL[k]!, value: fmtDate(a[`${k}_at`]), state: a[`${k}_at`] ? 'done' : a.next_step === k ? 'current' : 'todo' }))} />
          </div>))}
      </Panel>
      <div className="grid-2">
        <Panel title="Investigators">
          <DataTable rows={d.investigators} rowKey={i => i.id} columns={[
            { key: 'full_name', label: 'Name' }, { key: 'investigator_role', label: 'Role', render: i => i.investigator_role === 'principal' ? 'Principal' : 'Sub-investigator' },
            { key: 'specialty', label: 'Specialty', render: i => i.specialty ?? '—' },
            { key: 'gcp', label: 'GCP training until', render: i => <>{fmtDate(i.gcp_training_valid_until)} {i.gcp_training_valid_until && i.gcp_training_valid_until < today ? <StatusPill tone="bad">Expired</StatusPill> : null}</>, sortValue: i => i.gcp_training_valid_until },
          ]} />
        </Panel>
        <div className="stack">
          <Panel title="Certifications">
            <DataTable rows={d.certifications} rowKey={c => c.id} empty={<EmptyState title="No certifications recorded" />} columns={[
              { key: 'kind', label: 'Certification' }, { key: 'issuer', label: 'Issuer', render: c => c.issuer ?? '—' },
              { key: 'valid_until', label: 'Valid until', render: c => fmtDate(c.valid_until), sortValue: c => c.valid_until }]} />
          </Panel>
          <Panel title="Concurrent trials">
            <DataTable rows={d.concurrent_trials} rowKey={t => t.id} empty={<EmptyState title="No concurrent trials declared" />} columns={[
              { key: 'title', wrap: true, label: 'Study' }, { key: 'registry_id', label: 'Registry', render: t => <span className="t-mono">{t.registry_id ?? '—'}</span> },
              { key: 'c', label: 'Competes for population', render: t => t.competes_for_population ? <StatusPill tone="warn">Yes</StatusPill> : 'No' }]} />
          </Panel>
        </div>
      </div>
      <DefinitionList items={[['Status', <StatusPill tone={tone(d.status)}>{human(d.status)}</StatusPill>]]} />
      {step ? <ReasonDialog title={`Record ${STEP_LABEL[step.step]} for ${step.arm}`} description="The step is dated now." confirmLabel="Record step"
        reasonDefault={`${STEP_LABEL[step.step]} completed`} onClose={() => setStep(null)}
        onConfirm={async reason => { await api('POST', `/v1/site-activations/${step.act}/steps/${step.step}`, { reason, body: {} }); setStep(null); toast('Step recorded'); site.reload(); }} /> : null}
    </>
  );
}
