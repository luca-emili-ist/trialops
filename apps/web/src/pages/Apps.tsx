// TRO-040 Applications: catalogue (publisher, GxP class, scopes, residency, validation package), installation with scope
// approval, app roles and sign-in through TrialOps (APP-MF-01/02/04, APP-ID-01/02).
import { useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, Modal, SelectField, DefinitionList, EmptyState, useToast } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { fmtDate, human, tone } from '../format.ts';

interface CatalogueApp { app_id: string; version: string; publisher: string; gxp_class: string; scopes: string[]; roles: string[]; data_residency: string[];
  available_in_region?: boolean; validation_package: string | null; valid: boolean; manifest: Record<string, unknown> & { base_url?: string } }
interface Installation { id: string; app_id: string; version: string; gxp_class: string; status: string; approved_by: string | null; approved_at: string | null;
  manifest: CatalogueApp['manifest'] & { roles?: string[] }; scopes: { scope: string; revoked_at: string | null }[] }

const CLASS: Record<string, string> = { L0: 'Utility, no GxP data', L1: 'Reads GxP data', L2: 'Writes derived results', L3: 'GxP system of record' };

export function Apps() {
  const { platform, can } = useSession();
  const toast = useToast();
  const cat = useData<{ items: CatalogueApp[] }>('/v1/apps/catalogue');
  const inst = useData<{ items: Installation[] }>(platform ? `/v1/platforms/${platform.id}/apps` : null);
  const [approve, setApprove] = useState<Installation | null>(null);
  const [roles, setRoles] = useState<Installation | null>(null);
  const admin = can('platform_admin');
  const byApp = new Map((inst.data?.items ?? []).map(i => [i.app_id, i]));
  const act = (p: Promise<unknown>, ok: string) => p.then(() => { toast(ok); inst.reload(); }, e => toast((e as Error).message, true));
  return (
    <>
      <PageHeader title="Applications" subtitle="Vertical apps work with TrialOps through three contracts: identity, data and tasks. An app is active only after an administrator approves the scopes it asks for." />
      <Panel title="Catalogue">
        {cat.error ? <ErrorNote error={cat.error} /> : !cat.data ? <Loading /> :
          <DataTable rows={cat.data.items} rowKey={a => a.app_id} label="App catalogue" columns={[
            // TRO-040 at 1440 px: identity, class and state stacked in their cells, long values wrap: no horizontal scroll
            { key: 'app_id', label: 'App', wrap: true, render: a => <span className="cell-stack"><span className="t-mono nowrap">{a.app_id}</span>
              <small>{a.version} · {a.publisher}</small></span> },
            { key: 'gxp_class', label: 'GxP class', wrap: true, render: a => <span className="cell-stack"><span>{a.gxp_class} · {CLASS[a.gxp_class]}</span>
              <small>{a.validation_package ? 'Validation package provided' : a.gxp_class >= 'L2' ? 'Validation package missing' : 'No validation package required'}</small>
              {!a.validation_package && a.gxp_class >= 'L2' ? <span><StatusPill tone="bad">Package missing</StatusPill></span> : null}</span> },
            { key: 'scopes', wrap: true, label: 'Scopes', render: a => <span className="t-mono">{a.scopes.join(' ')}</span> },
            { key: 'res', label: 'Data residency', render: a => a.data_residency.join(', ') },
            { key: 'state', label: 'On this platform', wrap: true, render: a => { const i = byApp.get(a.app_id);
              const canInstall = admin && a.available_in_region !== false && (!i || i.status === 'uninstalled');
              return <span className="stack-sm">
                {i ? <span><StatusPill tone={tone(i.status)}>{human(i.status)}</StatusPill></span>
                  : a.available_in_region === false ? <span><StatusPill tone="warn">Not offered in this region</StatusPill></span> : <span>Not installed</span>}
                {canInstall ? <span><Button onClick={() => act(api('POST', `/v1/platforms/${platform!.id}/apps`, { body: { manifest: a.manifest } }), 'Installation requested')}>Request installation</Button></span> : null}
              </span>; } },
          ]} />}
      </Panel>
      <Panel title="Installed on this platform">
        {inst.error ? <ErrorNote error={inst.error} /> : !inst.data ? <Loading /> :
          <DataTable rows={inst.data.items} rowKey={i => i.id} empty={<EmptyState title="No apps installed" />} columns={[
            { key: 'app_id', label: 'App', render: i => <span className="t-mono">{i.app_id}</span> }, { key: 'version', label: 'Version' },
            { key: 'status', label: 'Status', render: i => <StatusPill tone={tone(i.status)}>{human(i.status)}</StatusPill> },
            { key: 'scopes', wrap: true, label: 'Granted scopes', render: i => <span className="t-mono">{i.scopes.filter(s => !s.revoked_at).map(s => s.scope).join(' ') || '—'}</span> },
            { key: 'approved', label: 'Approved', render: i => i.approved_at ? `${fmtDate(i.approved_at)} by ${i.approved_by}` : '—' },
            { key: 'actions', label: 'Actions', render: i => <div className="row">
              {admin && i.status === 'pending_approval' ? <Button variant="primary" onClick={() => setApprove(i)}>Review scopes</Button> : null}
              {admin && i.status === 'active' ? <Button onClick={() => setRoles(i)}>Assign role</Button> : null}
              {i.status === 'active' && i.manifest.base_url ? <a className="btn btn-secondary" href={`${i.manifest.base_url}/login`} target="_blank" rel="noreferrer">Open (sign in with TrialOps)</a> : null}
              {admin && i.status === 'active' ? <Button variant="danger" onClick={() => act(api('POST', `/v1/app-installations/${i.id}/uninstall`), 'App uninstalled, access revoked')}>Uninstall</Button> : null}
            </div> },
          ]} />}
      </Panel>
      {approve ? <Modal title={`Approve scopes for ${approve.app_id}`} onClose={() => setApprove(null)} actions={<>
          <Button onClick={() => setApprove(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => { act(api('POST', `/v1/app-installations/${approve.id}/approve`), 'App approved and active'); setApprove(null); }}>Approve and activate</Button></>}>
          <DefinitionList items={[['GxP class', `${approve.gxp_class} · ${CLASS[approve.gxp_class]}`],
            ['Scopes requested', <span className="t-mono">{((approve.manifest.scopes as string[]) ?? []).join(', ')}</span>],
            ['Roles declared', ((approve.manifest.roles as string[]) ?? []).join(', ') || '—'],
            ['Data residency', ((approve.manifest.data_residency as string[]) ?? []).join(', ')]]} />
          <p className="t-muted">People sign in to the app with their TrialOps account; the app receives only these scopes and only the arms they can see.</p>
        </Modal> : null}
      {roles ? <AssignRole inst={roles} onClose={() => setRoles(null)} /> : null}
    </>
  );
}

function AssignRole({ inst, onClose }: { inst: Installation; onClose: () => void }) {
  const { platform } = useSession();
  const toast = useToast();
  const people = useData<{ items: { id: string; full_name: string; roles: string }[] }>(`/v1/platforms/${platform!.id}/people`);
  const appRoles = inst.manifest.roles ?? [];
  const [person, setPerson] = useState(''); const [role, setRole] = useState(appRoles[0] ?? '');
  return <Modal title={`Assign a role in ${inst.app_id}`} onClose={onClose} actions={<><Button onClick={onClose}>Cancel</Button>
    <Button variant="primary" disabled={!person || !role} onClick={() => api('POST', `/v1/app-installations/${inst.id}/role-assignments`, { body: { person_id: person, role } })
      .then(() => { toast('Role assigned'); onClose(); }, e => toast((e as Error).message, true))}>Assign</Button></>}>
    <SelectField label="Person" value={person} onChange={e => setPerson(e.target.value)}
      options={[{ value: '', label: '— choose —' }, ...(people.data?.items ?? []).map(p => ({ value: p.id, label: `${p.full_name} (${p.roles.replace(/_/g, ' ')})` }))]} />
    <SelectField label="App role" value={role} onChange={e => setRole(e.target.value)} options={appRoles.map(r => ({ value: r, label: r }))} />
  </Modal>;
}
