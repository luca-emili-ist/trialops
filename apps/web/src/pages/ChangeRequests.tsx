// TRO-060 Change requests (UX-02): what people suggested from the pages with "Suggest changes" (UX-01). Platform admins
// filter them by status and page, triage them (status, note), copy one as a task for Claude or Local Dev, and remove one
// (void with a reason, never a physical delete). Every change is in the audit trail.
import { useEffect, useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Input, Select, SelectField, Loading, ErrorNote, EmptyState, ReasonDialog, useToast,
  formatUtc, changeRequestAsTask, type ChangeRequestRow, type Tone } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';

export const CHANGE_ADMIN_ROLES = ['platform_admin'] as const;

const STATUS: Record<string, { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'warn' }, triaged: { label: 'Triaged', tone: 'neutral' }, in_progress: { label: 'In progress', tone: 'info' },
  done: { label: 'Done', tone: 'neutral' }, rejected: { label: 'Rejected', tone: 'neutral' },
};
const KIND: Record<string, string> = { change: 'Change', bug: 'Bug', new: 'New feature' };

export function ChangeRequests() {
  const s = useSession();
  const toast = useToast();
  const allowed = s.can(...CHANGE_ADMIN_ROLES);
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState('');
  const [rows, setRows] = useState<ChangeRequestRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<ChangeRequestRow | null>(null);
  const list = useData<{ items: ChangeRequestRow[] }>(allowed && s.platform ? `/v1/change-requests?platform_id=${s.platform.id}&status=${status}` : null);
  useEffect(() => { if (list.data) setRows(list.data.items); }, [list.data]);

  if (!allowed) return <EmptyState title="Change requests are triaged by platform administrators">Use “Suggest changes” at the top right of any page to send one.</EmptyState>;

  const update = async (r: ChangeRequestRow, patch: { status?: string; triage_note?: string }) => {
    setBusy(r.id);
    try {
      const row = await api<ChangeRequestRow>('PATCH', `/v1/change-requests/${r.id}`, { body: patch, reason: 'Change request triage' });
      setRows(l => (l ?? []).map(x => (x.id === r.id ? row : x)).filter(x => status === 'all' || (status === 'open' ? ['new', 'triaged', 'in_progress'].includes(x.status) : x.status === status)));
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };
  const copy = async (r: ChangeRequestRow) => {
    const text = changeRequestAsTask(r);
    try { await navigator.clipboard.writeText(text); toast('Copied as a task (Markdown)'); } catch { window.prompt('Copy the task:', text); }
  };
  const pages = [...new Set((rows ?? []).map(r => r.page_code))].sort();
  const shown = (rows ?? []).filter(r => !page || r.page_code === page);

  return (
    <>
      <PageHeader title="Change requests" subtitle="Changes suggested from the pages with “Suggest changes”: page and component code, what the person saw and what should change. Triage them here; each change is in the audit trail." />
      <Panel title={rows ? `Requests (${shown.length})` : 'Requests'} actions={<>
        <SelectField label="Status" value={status} onChange={e => setStatus(e.target.value)} options={[{ value: 'open', label: 'Open (new, triaged, in progress)' },
          ...Object.entries(STATUS).map(([value, m]) => ({ value, label: m.label })), { value: 'all', label: 'All' }]} />
        <SelectField label="Page" value={page} onChange={e => setPage(e.target.value)} options={[{ value: '', label: 'All pages' }, ...pages.map(p => ({ value: p, label: p }))]} />
        <Button onClick={list.reload}>Reload</Button>
      </>} meta="Times are UTC. Removing a request voids it with a reason; it is never deleted.">
        {list.error ? <ErrorNote error={list.error} /> : !rows ? <Loading what="Loading the change requests" /> :
          <DataTable rows={shown} rowKey={r => r.id} empty={<EmptyState title="No change requests">They appear here when someone uses “Suggest changes”.</EmptyState>} columns={[
            { key: 'component_code', label: 'Component', wrap: true, sortValue: r => r.component_code ?? r.page_code, render: r => <span className="stack-sm">
              <span className="t-mono" title={r.dom_path ?? ''}>{r.component_code ?? r.page_code}</span>
              <small className="t-muted t-mono">{formatUtc(r.created_at)}</small></span> },
            { key: 'request', label: 'Request and triage note', wrap: true, render: r => <span className="cell-wide"><span className="stack-sm">
              <span>{r.request}</span>
              <small className="t-muted">{KIND[r.kind] ?? r.kind} · {r.created_email ?? r.created_by}{r.component_text
                ? ` · on “${r.component_text.slice(0, 60)}${r.component_text.length > 60 ? '…' : ''}”${r.component_kind ? ` (${r.component_kind})` : ''}` : ''}</small>
              <Input key={`${r.id}-${r.triage_note}`} aria-label={`Triage note of ${r.component_code ?? r.page_code}`} defaultValue={r.triage_note}
                placeholder="Triage note: who, when, why…" disabled={busy === r.id} onBlur={e => { if (e.target.value !== r.triage_note) void update(r, { triage_note: e.target.value }); }} />
            </span></span> },
            { key: 'status', label: 'Status', wrap: true, sortValue: r => r.status, render: r => <span className="stack-sm">
              <span><StatusPill tone={STATUS[r.status]?.tone ?? 'neutral'}>{STATUS[r.status]?.label ?? r.status}</StatusPill></span>
              <Select aria-label={`Status of ${r.component_code ?? r.page_code}`} value={r.status} disabled={busy === r.id}
                onChange={e => { void update(r, { status: e.target.value }); }}>
                {Object.entries(STATUS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </Select>
              <span className="row"><Button variant="ghost" onClick={() => { void copy(r); }}>Copy as task</Button>
                <Button variant="danger" disabled={busy === r.id} onClick={() => setVoiding(r)}>Remove</Button></span></span> },
          ]} />}
      </Panel>
      {voiding ? <ReasonDialog title={`Remove change request ${voiding.component_code ?? voiding.page_code}`} confirmLabel="Remove"
        description="The request is voided and leaves every list; it stays in the database and in the audit trail with your reason."
        reasonDefault="Duplicate or no longer relevant" onClose={() => setVoiding(null)}
        onConfirm={async reason => {
          await api('POST', `/v1/change-requests/${voiding.id}/void`, { reason });
          setRows(l => (l ?? []).filter(x => x.id !== voiding.id)); setVoiding(null); toast('Change request removed');
        }} /> : null}
    </>
  );
}
