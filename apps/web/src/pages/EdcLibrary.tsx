// TRO-070 CRF library and TRO-071 CRF version (EDC-01, EDC-04): versioned CRFs linked to protocol visits, CDASH item
// metadata, units and codelists from versioned dictionaries, declared edit checks, approval with a Part 11 signature.
import { useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, EmptyState, SignDialog, SignatureManifest, useToast,
  type SignatureLike } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { human, tone } from '../format.ts';
import { EDC_LIBRARY_ROLES, utc } from '../components/edc.ts';

// UI strings of these two pages, kept together so they can be localised (rule 15).
const T = {
  library: {
    title: 'CRF library', subtitle: 'Case report forms of the platform, versioned and linked to the visits of the Master Protocol. Approved versions are frozen.',
    oid: 'Form OID', name: 'Name', domain: 'CDASH domain', current: 'Current version', items: 'Items', checks: 'Edit checks', visits: 'Visits',
    versions: 'Versions', empty: 'No CRF in the library yet', none: 'none approved',
  },
  version: {
    crumbs: 'CRF library', status: 'Status', version: 'Version', approved: 'Approved', items: 'Items', checks: 'Edit checks', visits: 'Collected at visits',
    oid: 'Item OID', variable: 'CDASH variable', label: 'Label', type: 'Type', unitOrList: 'Unit / codelist', required: 'Required', yes: 'Yes', no: '—',
    code: 'Check', kind: 'Kind', rule: 'Rule', severity: 'On failure', message: 'Message', hard: 'Refuses the value', soft: 'Opens a query',
    approve: 'Approve and sign', newVersion: 'Start a new version', signed: 'Approval signature',
    signTitle: (n: number) => `Approve version ${n}`,
    signWhat: 'You approve this CRF version for data entry. It becomes frozen and supersedes the previous approved version. Authors of the version cannot approve it.',
    signConfirm: 'Sign and approve', signReason: 'CRF version reviewed and approved', signedToast: 'Version approved and signed',
    draftNote: 'Draft: items, edit checks and visits can still change through the Platform API; approval freezes them.',
    frozenNote: 'Frozen: a change needs a new version.', noVisits: 'Not scheduled at any visit',
  },
} as const;

interface VersionSummary { id: string; version_no: number; status: string; approved_at: string | null; items: number; checks: number; visits: string[] }
interface Form { id: string; oid: string; name: string; cdash_domain: string | null; status: string; versions: VersionSummary[] }

export function CrfLibrary() {
  const { platform } = useSession();
  const forms = useData<{ items: Form[] }>(platform ? `/v1/platforms/${platform.id}/crf-forms` : null);
  const L = T.library;
  const current = (f: Form) => f.versions.find(v => v.status === 'approved') ?? null;
  return (
    <>
      <PageHeader title={L.title} subtitle={L.subtitle} />
      {forms.error ? <ErrorNote error={forms.error} /> : !forms.data ? <Loading /> :
        <DataTable rows={forms.data.items} rowKey={f => f.id} empty={<EmptyState title={L.empty} />}
          onRowClick={f => { const v = current(f) ?? f.versions[0]; if (v) go(`/edc/crfs/${v.id}`); }} columns={[
            { key: 'oid', label: L.oid, render: f => <span className="t-mono">{f.oid}</span> },
            { key: 'name', label: L.name, wrap: true },
            { key: 'cdash_domain', label: L.domain, render: f => <span className="t-mono">{f.cdash_domain ?? '—'}</span> },
            { key: 'current', label: L.current, render: f => current(f) ? `v${current(f)!.version_no}` : L.none },
            { key: 'items', label: L.items, align: 'right', render: f => current(f)?.items ?? '—' },
            { key: 'checks', label: L.checks, align: 'right', render: f => current(f)?.checks ?? '—' },
            { key: 'visits', label: L.visits, render: f => <span className="t-mono">{current(f)?.visits.join(' · ') ?? '—'}</span> },
            { key: 'versions', label: L.versions, render: f => <span className="row">{f.versions.map(v =>
              <StatusPill key={v.id} tone={tone(v.status)}>{`v${v.version_no} ${human(v.status)}`}</StatusPill>)}</span> },
          ]} />}
    </>
  );
}

interface Item { id: string; oid: string; cdash_variable: string; label: string; data_type: string; required: boolean; unit: string | null;
  codelist_code: string | null; dictionary_version: string | null }
interface Check { id: string; code: string; kind: string; item_oid: string; operator: string | null; other_item_oid: string | null;
  min_value: string | null; max_value: string | null; severity: string; message: string }
interface Version { id: string; form_id: string; form_oid: string; form_name: string; version_no: number; status: string; approved_at: string | null;
  approved_signature: SignatureLike | null; items: Item[]; checks: Check[]; visits: { id: string; code: string; name: string; planned_day: number | null }[] }

export const ruleText = (k: Check) => k.kind === 'required' ? `${k.item_oid} present (value or ND/NA/UNK)`
  : k.kind === 'range' ? `${k.min_value ?? '−∞'} ≤ ${k.item_oid} ≤ ${k.max_value ?? '+∞'}` : `${k.item_oid} ${k.operator} ${k.other_item_oid}`;

export function CrfVersion({ id }: { id: string }) {
  const s = useSession();
  const toast = useToast();
  const v = useData<Version>(`/v1/crf-versions/${id}`);
  const [signing, setSigning] = useState(false);
  const V = T.version;
  if (v.error) return <ErrorNote error={v.error} />;
  if (!v.data) return <Loading />;
  const d = v.data;
  const editor = s.can(...EDC_LIBRARY_ROLES);
  return (
    <>
      <PageHeader crumbs={<a href="#/edc/crfs">{V.crumbs}</a>} title={`${d.form_name} — v${d.version_no}`}
        subtitle={d.status === 'draft' ? V.draftNote : V.frozenNote}
        facts={[[V.status, human(d.status)], [V.version, `${d.form_oid} v${d.version_no}`], [V.approved, utc(d.approved_at)]]}
        actions={editor ? <>
          {d.status === 'draft' ? <Button variant="sign" onClick={() => setSigning(true)}>{V.approve}</Button> : null}
          {d.status === 'approved' ? <Button onClick={() => api('POST', `/v1/crf-forms/${d.form_id}/versions`, { body: {} })
            .then(n => go(`/edc/crfs/${n.id}`), e => toast((e as Error).message, true))}>{V.newVersion}</Button> : null}
        </> : undefined} />
      {d.approved_signature ? <Panel title={V.signed}><SignatureManifest signature={d.approved_signature} /></Panel> : null}
      <Panel title={`${V.items} (${d.items.length})`}>
        <DataTable rows={d.items} rowKey={i => i.id} columns={[
          { key: 'oid', label: V.oid, render: i => <span className="t-mono">{i.oid}</span> },
          { key: 'cdash_variable', label: V.variable, render: i => <span className="t-mono">{i.cdash_variable}</span> },
          { key: 'label', label: V.label, wrap: true },
          { key: 'data_type', label: V.type },
          { key: 'unit', label: V.unitOrList, render: i => <span className="t-mono">{i.unit ?? (i.codelist_code ? `${i.codelist_code} (${i.dictionary_version})` : '—')}</span> },
          { key: 'required', label: V.required, render: i => i.required ? V.yes : V.no },
        ]} />
      </Panel>
      <Panel title={`${V.checks} (${d.checks.length})`}>
        <DataTable rows={d.checks} rowKey={k => k.id} columns={[
          { key: 'code', label: V.code, render: k => <span className="t-mono">{k.code}</span> },
          { key: 'kind', label: V.kind },
          { key: 'rule', label: V.rule, render: k => <span className="t-mono">{ruleText(k)}</span> },
          { key: 'severity', label: V.severity, render: k => k.severity === 'hard' ? V.hard : V.soft },
          { key: 'message', label: V.message, wrap: true },
        ]} />
      </Panel>
      <Panel title={V.visits}>
        {d.visits.length ? <p className="t-mono">{d.visits.map(x => `${x.code} (${x.name})`).join(' · ')}</p> : <EmptyState title={V.noVisits} />}
      </Panel>
      {signing ? <SignDialog title={V.signTitle(d.version_no)} meaning="approval" what={V.signWhat} confirmLabel={V.signConfirm}
        reasonDefault={V.signReason} onClose={() => setSigning(false)}
        onSign={async (password, reason, totp) => {
          await api('POST', `/v1/crf-versions/${d.id}/approve`, { reason, body: { password, totp } });
          setSigning(false); toast(V.signedToast); v.reload();
        }} /> : null}
    </>
  );
}
