// TRO-013 Structured Master Protocol / arm appendix editor (M01-01) on controlled versions (DM-02, CMP-02, IAM-05).
import { useState } from 'react';
import { PageHeader, Panel, Button, StatusPill, Loading, ErrorNote, DefinitionList, ReasonDialog, SignDialog, TextField, Modal, useToast } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { fmtDateTime, human, tone, short } from '../format.ts';
import { SECTIONS, SectionEditor, clean, type Content } from '../components/ProtocolSections.tsx';

interface Version { id: string; platform_id: string; arm_id?: string; version_label: string; usdm: Content; status: string; approved_signature_id: string | null; updated_at: string; row_version: number }

export function ProtocolEditor({ kind, id }: { kind: 'master' | 'appendix'; id: string }) {
  const base = kind === 'master' ? '/v1/protocol-versions' : '/v1/appendix-versions';
  const v = useData<Version>(`${base}/${id}`);
  const s = useSession();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [dialog, setDialog] = useState<null | 'save' | 'submit' | 'return' | 'approve' | 'new'>(null);
  const [label, setLabel] = useState('');
  if (v.error) return <ErrorNote error={v.error} />;
  if (!v.data) return <Loading />;
  const ver = v.data;
  const isDraft = ver.status === 'draft';
  const canEdit = s.can('platform_admin', 'platform_ops_manager', 'regulatory_lead', ...(kind === 'appendix' ? ['arm_sponsor_lead'] : []));
  const canApprove = s.can('platform_admin', 'regulatory_lead');
  const title = kind === 'master' ? 'Master Protocol' : 'Arm appendix';
  const run = async (fn: () => Promise<unknown>, ok: string) => { await fn(); setDialog(null); toast(ok); v.reload(); };
  return (
    <>
      <PageHeader crumbs={<><a href="#/arms">Arms & protocol</a>{ver.arm_id ? <> · <a href={`#/arms/${ver.arm_id}`}>Arm</a></> : null}</>}
        title={`${title} v${ver.version_label}`}
        subtitle="Structured content following ICH M11 headings and CDISC USDM objects. Approved versions are frozen; changes start a new version."
        actions={<>
          {isDraft && canEdit ? <Button variant="primary" onClick={() => setDialog('submit')}>Send for review</Button> : null}
          {ver.status === 'in_review' && (canEdit || canApprove) ? <Button onClick={() => setDialog('return')}>Return to draft</Button> : null}
          {ver.status === 'in_review' && canApprove ? <Button variant="sign" onClick={() => setDialog('approve')}>Approve and sign</Button> : null}
          {ver.status === 'approved' && canEdit ? <Button variant="primary" onClick={() => setDialog('new')}>Start new version</Button> : null}
        </>} />
      <Panel meta={`Version id ${short(ver.id)} · row version ${ver.row_version} · last change ${fmtDateTime(ver.updated_at)}`}>
        <DefinitionList items={[
          ['Status', <StatusPill tone={tone(ver.status)}>{human(ver.status)}</StatusPill>],
          ['Approval signature', ver.approved_signature_id ? <span className="t-mono">{short(ver.approved_signature_id)}</span> : 'Not signed'],
        ]} />
      </Panel>
      {SECTIONS.map(sec => {
        const isEditing = editing === sec.key;
        return (
          <Panel key={sec.key} title={`${sec.m11} · ${sec.title}`} actions={isDraft && canEdit ? (isEditing
            ? <><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={() => setDialog('save')}>Save section</Button></>
            : <Button onClick={() => { setEditing(sec.key); setDraft(ver.usdm[sec.key] ?? (sec.list ? [] : {})); }}>Edit</Button>) : undefined}>
            <SectionEditor sectionKey={sec.key} value={isEditing ? draft : ver.usdm[sec.key]} onChange={setDraft} editing={isEditing} />
          </Panel>);
      })}
      {dialog === 'save' && editing ? <ReasonDialog title={`Save ${editing}`} confirmLabel="Save" onClose={() => setDialog(null)}
        onConfirm={reason => run(() => api('PUT', `${base}/${id}/sections/${editing}`, { reason, body: { content: clean(draft) } }).then(() => setEditing(null)), 'Section saved')} /> : null}
      {dialog === 'submit' ? <ReasonDialog title="Send for review" description="The version is locked while in review." confirmLabel="Send for review"
        reasonDefault="Draft complete" onClose={() => setDialog(null)} onConfirm={reason => run(() => api('POST', `${base}/${id}/submit`, { reason }), 'Sent for review')} /> : null}
      {dialog === 'return' ? <ReasonDialog title="Return to draft" confirmLabel="Return to draft" onClose={() => setDialog(null)}
        onConfirm={reason => run(() => api('POST', `${base}/${id}/return`, { reason }), 'Returned to draft')} /> : null}
      {dialog === 'approve' ? <SignDialog title={`Approve ${title} v${ver.version_label}`} meaning="approval"
        what="You approve this version as the controlled content. It becomes frozen and supersedes the previous approved version. Authors of the version cannot approve it."
        confirmLabel="Sign and approve" reasonDefault="Content reviewed and approved" onClose={() => setDialog(null)}
        onSign={(password, reason) => run(() => api('POST', `${base}/${id}/approve`, { reason, body: { password } }), 'Approved and signed')} /> : null}
      {dialog === 'new' ? <Modal title="Start a new version" onClose={() => setDialog(null)} actions={<>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button variant="primary" disabled={!label} onClick={() => {
            const parent = kind === 'master' ? `/v1/platforms/${ver.platform_id}/protocol-versions` : `/v1/arms/${ver.arm_id}/appendix-versions`;
            api<Version>('POST', parent, { body: { version_label: label, copy_from: ver.id } })
              .then(n => { setDialog(null); go(`/protocol/${kind}/${n.id}`); }, e => toast((e as Error).message, true));
          }}>Create draft</Button></>}>
          <TextField label="Version label" value={label} onChange={e => setLabel(e.target.value)} hint="For example 1.1 or 2.0" />
        </Modal> : null}
    </>
  );
}
