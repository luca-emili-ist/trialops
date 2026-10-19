// TRO-020 Site network and TRO-021 Site detail: registry (M02-01) and per-arm activation workflow (M02-03).
// Site-facing: localised in English and Japanese (NFR-07).
import { useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, DefinitionList, Steps, ReasonDialog, Modal, TextField, SelectField, EmptyState, useToast, useT } from '@trialops/shell';
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
  const t = useT();
  const sites = useData<{ items: SiteRow[] }>(platform ? `/v1/platforms/${platform.id}/sites` : null);
  const [adding, setAdding] = useState(false);
  const avg = sites.data?.items.length ? sites.data.items.reduce((a, s) => a + s.randomized, 0) / sites.data.items.length : 0;
  return (
    <>
      <PageHeader title={t('Site network')} subtitle={t('Registry of sites, investigators, certifications and competing trials, with enrollment per site.')}
        actions={can('platform_admin', 'platform_ops_manager', 'ctm') ? <Button variant="primary" onClick={() => setAdding(true)}>{t('Register site')}</Button> : undefined} />
      {sites.error ? <ErrorNote error={sites.error} /> : !sites.data ? <Loading /> :
        <DataTable rows={sites.data.items} rowKey={s => s.id} onRowClick={s => go(`/sites/${s.id}`)} label={t('Sites')} columns={[
          { key: 'site_number', label: t('Site') }, { key: 'name', wrap: true, label: t('Name') }, { key: 'pi_name', label: t('Principal investigator'), render: s => s.pi_name ?? '—' },
          { key: 'cap', label: t('Capacity / month'), align: 'right', render: s => s.declared_capacity_per_month ?? '—', sortValue: s => Number(s.declared_capacity_per_month) },
          { key: 'identified', label: t('Identified'), align: 'right', sortValue: s => s.identified, render: s => s.identified },
          { key: 'randomized', label: t('Randomized'), align: 'right', sortValue: s => s.randomized,
            render: s => <>{s.randomized} {s.randomized < avg * 0.5 ? <StatusPill tone="bad">{t('Below half of average')}</StatusPill> : null}</> },
          { key: 'arms_activated', label: t('Arms active'), align: 'right', render: s => s.arms_activated, sortValue: s => s.arms_activated },
          { key: 'competing_trials', label: t('Competing trials'), align: 'right', render: s => s.competing_trials, sortValue: s => s.competing_trials },
          { key: 'status', label: t('Status'), render: s => <StatusPill tone={tone(s.status)}>{t(human(s.status))}</StatusPill>, sortValue: s => s.status },
        ]} />}
      {adding ? <RegisterSite onClose={() => setAdding(false)} onDone={() => { setAdding(false); sites.reload(); }} /> : null}
    </>
  );
}

function RegisterSite({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { platform } = useSession();
  const toast = useToast();
  const t = useT();
  const orgs = useData<{ items: { id: string; name: string }[] }>('/v1/organizations?type=site');
  const [f, setF] = useState({ org_id: '', site_number: '', country: 'US', cap: '' });
  return <Modal title={t('Register a candidate site')} onClose={onClose} actions={<><Button onClick={onClose}>{t('Cancel')}</Button>
    <Button variant="primary" disabled={!f.org_id || !f.site_number} onClick={() => api('POST', `/v1/platforms/${platform!.id}/sites`, { body: {
      org_id: f.org_id, site_number: f.site_number, country: f.country, ...(f.cap ? { declared_capacity_per_month: Number(f.cap) } : {}) } })
      .then(() => { toast(t('Site registered')); onDone(); }, e => toast((e as Error).message, true))}>{t('Register')}</Button></>}>
    <SelectField label={t('Organization')} value={f.org_id} onChange={e => setF({ ...f, org_id: e.target.value })}
      options={[{ value: '', label: t('— choose —') }, ...(orgs.data?.items ?? []).map(o => ({ value: o.id, label: o.name }))]} />
    <div className="form-grid">
      <TextField label={t('Site number')} value={f.site_number} onChange={e => setF({ ...f, site_number: e.target.value })} />
      <TextField label={t('Country (ISO)')} value={f.country} maxLength={2} onChange={e => setF({ ...f, country: e.target.value.toUpperCase() })} />
      <TextField label={t('Capacity per month')} type="number" value={f.cap} onChange={e => setF({ ...f, cap: e.target.value })} />
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
  const t = useT();
  const site = useData<SiteDetailData>(`/v1/sites/${id}`);
  const [step, setStep] = useState<{ act: string; step: string; arm: string } | null>(null);
  if (site.error) return <ErrorNote error={site.error} />;
  if (!site.data) return <Loading />;
  const d = site.data;
  const editor = s.can('platform_admin', 'platform_ops_manager', 'ctm');
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHeader crumbs={<a href="#/sites">{t('Site network')}</a>} title={t('Site {n} — {name}', { n: d.site_number, name: d.name })}
        subtitle={t('{country} · capacity {cap} subjects per month', { country: d.country, cap: d.declared_capacity_per_month ?? '—' })} />
      <Panel title={t('Activation per arm')} meta={t('Each step is dated in order; the green light needs all previous steps and an active arm.')}>
        {!d.activations.length ? <EmptyState title={t('This site is not being activated for any arm')} /> : d.activations.map(a => (
          <div className="stack-sm" key={a.id}>
            <div className="row"><strong>{a.arm_code}</strong><StatusPill tone={tone(a.status)}>{t(human(a.status))}</StatusPill>
              {a.next_step && editor ? <Button variant="primary" onClick={() => setStep({ act: a.id, step: a.next_step!, arm: a.arm_code })}>{t('Record {step}', { step: t(STEP_LABEL[a.next_step]!) })}</Button> : null}</div>
            <Steps steps={STEPS.map(k => ({ label: t(STEP_LABEL[k]!), value: fmtDate(a[`${k}_at`]), state: a[`${k}_at`] ? 'done' : a.next_step === k ? 'current' : 'todo' }))} />
          </div>))}
      </Panel>
      <div className="grid-2">
        <Panel title={t('Investigators')}>
          <DataTable label={t('Investigators')} rows={d.investigators} rowKey={i => i.id} columns={[
            { key: 'full_name', label: t('Name') }, { key: 'investigator_role', label: t('Role'), render: i => i.investigator_role === 'principal' ? t('Principal') : t('Sub-investigator') },
            { key: 'specialty', label: t('Specialty'), render: i => i.specialty ?? '—' },
            { key: 'gcp', label: t('GCP training until'), render: i => <>{fmtDate(i.gcp_training_valid_until)} {i.gcp_training_valid_until && i.gcp_training_valid_until < today ? <StatusPill tone="bad">{t('Expired')}</StatusPill> : null}</>, sortValue: i => i.gcp_training_valid_until },
          ]} />
        </Panel>
        <div className="stack">
          <Panel title={t('Certifications')}>
            <DataTable label={t('Certifications')} rows={d.certifications} rowKey={c => c.id} empty={<EmptyState title={t('No certifications recorded')} />} columns={[
              { key: 'kind', label: t('Certification') }, { key: 'issuer', label: t('Issuer'), render: c => c.issuer ?? '—' },
              { key: 'valid_until', label: t('Valid until'), render: c => fmtDate(c.valid_until), sortValue: c => c.valid_until }]} />
          </Panel>
          <Panel title={t('Concurrent trials')}>
            <DataTable label={t('Concurrent trials')} rows={d.concurrent_trials} rowKey={c => c.id} empty={<EmptyState title={t('No concurrent trials declared')} />} columns={[
              { key: 'title', wrap: true, label: t('Study') }, { key: 'registry_id', label: t('Registry'), render: c => <span className="t-mono">{c.registry_id ?? '—'}</span> },
              { key: 'c', label: t('Competes for population'), render: c => c.competes_for_population ? <StatusPill tone="warn">{t('Yes')}</StatusPill> : t('No') }]} />
          </Panel>
        </div>
      </div>
      <DefinitionList items={[[t('Status'), <StatusPill tone={tone(d.status)}>{t(human(d.status))}</StatusPill>]]} />
      {step ? <ReasonDialog title={t('Record {step} for {arm}', { step: t(STEP_LABEL[step.step]!), arm: step.arm })} description={t('The step is dated now.')} confirmLabel={t('Record step')}
        reasonDefault={`${STEP_LABEL[step.step]} completed`} onClose={() => setStep(null)}
        onConfirm={async reason => { await api('POST', `/v1/site-activations/${step.act}/steps/${step.step}`, { reason, body: {} }); setStep(null); toast(t('Step recorded')); site.reload(); }} /> : null}
    </>
  );
}
