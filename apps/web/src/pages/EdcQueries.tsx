// TRO-075 Data queries (EDC-05): every query of the platform within the reader's perimeter, open first. The site answers,
// data managers and monitors close, cancel or re-query, always with a reason (audit trail). Blinded: no allocation.
import { useState } from 'react';
import { PageHeader, DataTable, StatusPill, Button, Loading, ErrorNote, EmptyState, Modal, TextField, SelectField, ReasonDialog, KeyFigures,
  useToast, useT } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { human } from '../format.ts';
import { EDC_REVIEW_ROLES, EDC_SITE_ROLES, queryTone, utc } from '../components/edc.ts';

// UI strings of this page, kept together and translated through t() (NFR-07, rule 15; Japanese in apps/web/src/i18n/ja.ts).
type Tr = (text: string, vars?: Record<string, string | number>) => string;
const T = (t: Tr) => ({
  title: t('Data queries'), subtitle: t('Queries opened by the edit checks or by data managers and monitors. The site answers; the review closes them.'),
  filter: t('Status'), all: t('All'), statuses: { open: t('Open'), answered: t('Answered'), closed: t('Closed'), cancelled: t('Cancelled') },
  subject: t('Subject'), site: t('Site'), visit: t('Visit'), item: t('Item'), value: t('Value'), question: t('Question'), status: t('Status'), opened: t('Opened (UTC)'),
  actions: t('Actions'), empty: t('No queries match'), answer: t('Answer'), close: t('Close'), cancel: t('Cancel query'), requery: t('Re-query'),
  answerTitle: t('Answer the query'), answerLabel: t('Answer'), answerConfirm: t('Send answer'), back: t('Back'),
  closeTitle: t('Close the query'), cancelTitle: t('Cancel the query'), requeryTitle: t('Re-open the answered query'), done: t('Query updated'),
  figures: { open: t('Open'), answered: t('Waiting for review'), closed: t('Closed') }, table: t('Data queries'),
});

interface Row { id: string; status: string; origin: string; question: string; answer: string | null; subject_code: string; site_number: string;
  subject_visit_id: string; visit_code: string; form_oid: string; item_oid: string | null; item_label: string | null; check_code: string | null;
  value: string | null; missing_reason: string | null; opened_at: string }

export function EdcQueries() {
  const s = useSession();
  const toast = useToast();
  const t = useT();
  const S = T(t);
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
    setDialog(null); setText(''); toast(S.done); list.reload(); all.reload();
  };
  return (
    <>
      <PageHeader title={S.title} subtitle={S.subtitle} />
      <KeyFigures items={[{ label: S.figures.open, value: count('open') }, { label: S.figures.answered, value: count('answered') },
        { label: S.figures.closed, value: count('closed') }]} />
      <SelectField label={S.filter} value={status} onChange={e => setStatus(e.target.value)}
        options={[{ value: '', label: S.all }, ...Object.entries(S.statuses).map(([value, label]) => ({ value, label }))]} />
      {list.error ? <ErrorNote error={list.error} /> : !list.data ? <Loading /> :
        <DataTable label={S.table} rows={list.data.items} rowKey={q => q.id} onRowClick={q => go(`/edc/visits/${q.subject_visit_id}`)} empty={<EmptyState title={S.empty} />} columns={[
          { key: 'subject_code', label: S.subject, render: q => <span className="t-mono">{q.subject_code}</span> },
          { key: 'site_number', label: S.site },
          { key: 'visit_code', label: S.visit, render: q => <span className="t-mono">{`${q.visit_code} · ${q.form_oid}`}</span> },
          { key: 'item', label: S.item, render: q => q.item_label ?? '—', wrap: true },
          { key: 'value', label: S.value, render: q => <span className="t-mono">{q.value ?? q.missing_reason ?? '—'}</span> },
          { key: 'question', label: S.question, wrap: true },
          { key: 'status', label: S.status, render: q => <StatusPill tone={queryTone(q.status)}>{t(human(q.status))}</StatusPill>,
            sortValue: q => ['open', 'answered', 'closed', 'cancelled'].indexOf(q.status) },
          { key: 'opened_at', label: S.opened, render: q => <span className="t-mono">{utc(q.opened_at)}</span>, sortValue: q => q.opened_at },
          { key: 'actions', label: S.actions, render: q => <span className="row" onClick={e => e.stopPropagation()}>
            {site && q.status === 'open' ? <Button onClick={() => { setText(''); setDialog({ kind: 'answer', q }); }}>{S.answer}</Button> : null}
            {review && (q.status === 'open' || q.status === 'answered') ? <Button variant="ghost" onClick={() => setDialog({ kind: 'close', q })}>{S.close}</Button> : null}
            {review && q.status === 'open' ? <Button variant="ghost" onClick={() => setDialog({ kind: 'cancel', q })}>{S.cancel}</Button> : null}
            {review && q.status === 'answered' ? <Button variant="ghost" onClick={() => setDialog({ kind: 'requery', q })}>{S.requery}</Button> : null}
          </span> },
        ]} />}
      {dialog?.kind === 'answer' ? <Modal title={S.answerTitle} onClose={() => setDialog(null)} actions={<>
          <Button onClick={() => setDialog(null)}>{S.back}</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => act(`/v1/edc-queries/${dialog.q.id}/answer`, { answer: text.trim() })
            .catch(e => toast((e as Error).message, true))}>{S.answerConfirm}</Button></>}>
        <p>{dialog.q.question}</p>
        <TextField label={S.answerLabel} value={text} onChange={e => setText(e.target.value)} />
      </Modal> : null}
      {dialog && dialog.kind !== 'answer' ? <ReasonDialog title={dialog.kind === 'close' ? S.closeTitle : dialog.kind === 'cancel' ? S.cancelTitle : S.requeryTitle}
        description={dialog.q.question} confirmLabel={dialog.kind === 'close' ? S.close : dialog.kind === 'cancel' ? S.cancel : S.requery}
        onClose={() => setDialog(null)} onConfirm={reason => act(`/v1/edc-queries/${dialog.q.id}/${dialog.kind}`, { reason })} /> : null}
    </>
  );
}
