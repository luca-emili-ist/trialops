// TRO-075 Data queries (EDC-05): every query of the platform within the reader's perimeter, open first. The site answers,
// data managers and monitors close, cancel or re-query, always with a reason (audit trail). Blinded: no allocation.
import { useState } from 'react';
import { PageHeader, DataTable, StatusPill, Button, Loading, ErrorNote, EmptyState, Modal, TextField, SelectField, ReasonDialog, KeyFigures,
  useToast } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { human } from '../format.ts';
import { EDC_REVIEW_ROLES, EDC_SITE_ROLES, queryTone, utc } from '../components/edc.ts';

// UI strings of this page, kept together so they can be localised (rule 15).
const T = {
  title: 'Data queries', subtitle: 'Queries opened by the edit checks or by data managers and monitors. The site answers; the review closes them.',
  filter: 'Status', all: 'All', statuses: { open: 'Open', answered: 'Answered', closed: 'Closed', cancelled: 'Cancelled' },
  subject: 'Subject', site: 'Site', visit: 'Visit', item: 'Item', value: 'Value', question: 'Question', status: 'Status', opened: 'Opened (UTC)',
  actions: 'Actions', empty: 'No queries match', answer: 'Answer', close: 'Close', cancel: 'Cancel query', requery: 'Re-query',
  answerTitle: 'Answer the query', answerLabel: 'Answer', answerConfirm: 'Send answer', back: 'Back',
  closeTitle: 'Close the query', cancelTitle: 'Cancel the query', requeryTitle: 'Re-open the answered query', done: 'Query updated',
  figures: { open: 'Open', answered: 'Waiting for review', closed: 'Closed' },
} as const;

interface Row { id: string; status: string; origin: string; question: string; answer: string | null; subject_code: string; site_number: string;
  subject_visit_id: string; visit_code: string; form_oid: string; item_oid: string | null; item_label: string | null; check_code: string | null;
  value: string | null; missing_reason: string | null; opened_at: string }

export function EdcQueries() {
  const s = useSession();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const list = useData<{ items: Row[] }>(s.platform ? `/v1/platforms/${s.platform.id}/edc-queries${status ? `?status=${status}` : ''}` : null);
  const all = useData<{ items: Row[] }>(s.platform ? `/v1/platforms/${s.platform.id}/edc-queries` : null);
  const [dialog, setDialog] = useState<{ kind: 'answer' | 'close' | 'cancel' | 'requery'; q: Row } | null>(null);
  const [text, setText] = useState('');
  const site = s.can(...EDC_SITE_ROLES);
  const review = s.can(...EDC_REVIEW_ROLES);
  const count = (st: string) => all.data?.items.filter(q => q.status === st).length ?? 0;
  const act = async (path: string, body: unknown) => {
    await api('POST', path, { body });
    setDialog(null); setText(''); toast(T.done); list.reload(); all.reload();
  };
  return (
    <>
      <PageHeader title={T.title} subtitle={T.subtitle} />
      <KeyFigures items={[{ label: T.figures.open, value: count('open') }, { label: T.figures.answered, value: count('answered') },
        { label: T.figures.closed, value: count('closed') }]} />
      <SelectField label={T.filter} value={status} onChange={e => setStatus(e.target.value)}
        options={[{ value: '', label: T.all }, ...Object.entries(T.statuses).map(([value, label]) => ({ value, label }))]} />
      {list.error ? <ErrorNote error={list.error} /> : !list.data ? <Loading /> :
        <DataTable rows={list.data.items} rowKey={q => q.id} onRowClick={q => go(`/edc/visits/${q.subject_visit_id}`)} empty={<EmptyState title={T.empty} />} columns={[
          { key: 'subject_code', label: T.subject, render: q => <span className="t-mono">{q.subject_code}</span> },
          { key: 'site_number', label: T.site },
          { key: 'visit_code', label: T.visit, render: q => <span className="t-mono">{`${q.visit_code} · ${q.form_oid}`}</span> },
          { key: 'item', label: T.item, render: q => q.item_label ?? '—', wrap: true },
          { key: 'value', label: T.value, render: q => <span className="t-mono">{q.value ?? q.missing_reason ?? '—'}</span> },
          { key: 'question', label: T.question, wrap: true },
          { key: 'status', label: T.status, render: q => <StatusPill tone={queryTone(q.status)}>{human(q.status)}</StatusPill>,
            sortValue: q => ['open', 'answered', 'closed', 'cancelled'].indexOf(q.status) },
          { key: 'opened_at', label: T.opened, render: q => <span className="t-mono">{utc(q.opened_at)}</span>, sortValue: q => q.opened_at },
          { key: 'actions', label: T.actions, render: q => <span className="row" onClick={e => e.stopPropagation()}>
            {site && q.status === 'open' ? <Button onClick={() => { setText(''); setDialog({ kind: 'answer', q }); }}>{T.answer}</Button> : null}
            {review && (q.status === 'open' || q.status === 'answered') ? <Button variant="ghost" onClick={() => setDialog({ kind: 'close', q })}>{T.close}</Button> : null}
            {review && q.status === 'open' ? <Button variant="ghost" onClick={() => setDialog({ kind: 'cancel', q })}>{T.cancel}</Button> : null}
            {review && q.status === 'answered' ? <Button variant="ghost" onClick={() => setDialog({ kind: 'requery', q })}>{T.requery}</Button> : null}
          </span> },
        ]} />}
      {dialog?.kind === 'answer' ? <Modal title={T.answerTitle} onClose={() => setDialog(null)} actions={<>
          <Button onClick={() => setDialog(null)}>{T.back}</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => act(`/v1/edc-queries/${dialog.q.id}/answer`, { answer: text.trim() })
            .catch(e => toast((e as Error).message, true))}>{T.answerConfirm}</Button></>}>
        <p>{dialog.q.question}</p>
        <TextField label={T.answerLabel} value={text} onChange={e => setText(e.target.value)} />
      </Modal> : null}
      {dialog && dialog.kind !== 'answer' ? <ReasonDialog title={dialog.kind === 'close' ? T.closeTitle : dialog.kind === 'cancel' ? T.cancelTitle : T.requeryTitle}
        description={dialog.q.question} confirmLabel={dialog.kind === 'close' ? T.close : dialog.kind === 'cancel' ? T.cancel : T.requery}
        onClose={() => setDialog(null)} onConfirm={reason => act(`/v1/edc-queries/${dialog.q.id}/${dialog.kind}`, { reason })} /> : null}
    </>
  );
}
