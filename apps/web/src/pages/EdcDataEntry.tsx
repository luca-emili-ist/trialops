// TRO-072 EDC subjects, TRO-073 subject casebook, TRO-074 visit data entry (EDC-03, EDC-04, EDC-05, EDC-11, EDC-12).
// The site enters typed values or a missing-data reason; the database stamps author and server UTC time, runs the edit
// checks on save (soft: a query opens, hard: the value is refused) and keeps every prior value with its reason.
// Blinded by construction: the API never returns the allocation, and these pages never ask for it.
import { useEffect, useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, EmptyState, Modal, TextField, SelectField, ReasonDialog,
  DefinitionList, useToast } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { human, tone } from '../format.ts';
import { EDC_REVIEW_ROLES, EDC_SITE_ROLES, queryTone, today, utc, type EdcQuery } from '../components/edc.ts';

// UI strings of these three pages, kept together so they can be localised (rule 15: site-facing pages in English and Japanese).
const T = {
  subjects: {
    title: 'Data entry', subtitle: 'Subjects of your sites with their visits and open data queries. Treatment allocation is never shown here (blinded).',
    code: 'Subject', site: 'Site', status: 'Status', visits: 'Visits completed', queries: 'Open queries', empty: 'No subject in data entry for your sites',
    queriesPill: (n: number) => `${n} open`,
  },
  casebook: {
    crumbs: 'Data entry', title: (code: string) => `Subject ${code}`, subtitle: 'Visit schedule of the Master Protocol and the visits recorded for this subject.',
    site: 'Site', status: 'Status', visit: 'Visit', name: 'Name', day: 'Planned day', date: 'Visit date', visitStatus: 'Visit status', queries: 'Open queries',
    notStarted: 'not started', start: 'Start visit', startTitle: (code: string) => `Start visit ${code}`,
    dateLabel: 'Visit date', dateHint: 'Date of the visit at the site; it cannot be in the future (UTC).', cancel: 'Cancel', confirm: 'Start visit',
  },
  visit: {
    crumbs: 'Data entry', title: (subject: string, visit: string) => `${subject} · ${visit}`, site: 'Site', date: 'Visit date', status: 'Status',
    completed: 'Completed', completeVisit: 'Complete visit', completedToast: 'Visit completed: data available (visit.completed)',
    startForm: 'Start form', formStarted: 'Form started', notStarted: 'Not started', openQueries: (n: number) => `${n} open ${n === 1 ? 'query' : 'queries'}`, version: (n: number) => `CRF version ${n}`,
    value: 'Value', missing: 'Missing data', missingNone: '—', missingOptions: { ND: 'ND · not done', NA: 'NA · not applicable', UNK: 'UNK · unknown' },
    entered: (by: string, at: string) => `Entered by ${by} · ${at}`, required: 'required', choose: '— choose —',
    save: 'Save', saved: 'Saved', savedQueries: (n: number) => `Saved: ${n} edit check ${n === 1 ? 'query' : 'queries'} opened`,
    reasonTitle: 'Reason for changing saved values', reasonText: 'The previous values stay in the audit trail with this reason.', reasonConfirm: 'Save changes',
    complete: 'Mark form complete', completeToast: 'Form complete', reopen: 'Reopen form', reopenTitle: 'Reopen the form', reopenConfirm: 'Reopen',
    queries: 'Data queries', noQueries: 'No queries on this form', answer: 'Answer', answerTitle: 'Answer the query', answerLabel: 'Answer',
    answerConfirm: 'Send answer', answered: 'Answer sent', close: 'Close', closeTitle: 'Close the query', closeConfirm: 'Close query', closedToast: 'Query closed',
    opened: (by: string, at: string) => `Opened by ${by} · ${at}`, byCheck: (code: string) => `edit check ${code}`, manual: 'manual query',
    answerLine: (a: string, by: string | null) => `${a}${by ? ` (${by})` : ''}`,
    origin: 'Origin', openedK: 'Opened', answerK: 'Answer', closedK: 'Closed',
  },
} as const;

// ===================================================================================================================
// TRO-072 subjects
// ===================================================================================================================
interface SubjectRow { id: string; subject_code: string; site_number: string; status: string; visits: number; visits_completed: number; queries_open: number }

export function EdcSubjects() {
  const { platform } = useSession();
  const list = useData<{ items: SubjectRow[] }>(platform ? `/v1/platforms/${platform.id}/edc/subjects` : null);
  const S = T.subjects;
  return (
    <>
      <PageHeader title={S.title} subtitle={S.subtitle} />
      {list.error ? <ErrorNote error={list.error} /> : !list.data ? <Loading /> :
        <DataTable rows={list.data.items} rowKey={r => r.id} onRowClick={r => go(`/edc/subjects/${r.id}`)} empty={<EmptyState title={S.empty} />} columns={[
          { key: 'subject_code', label: S.code, render: r => <span className="t-mono">{r.subject_code}</span> },
          { key: 'site_number', label: S.site },
          { key: 'status', label: S.status, render: r => human(r.status) },
          { key: 'visits', label: S.visits, align: 'right', render: r => `${r.visits_completed} / ${r.visits}`, sortValue: r => r.visits_completed },
          { key: 'queries_open', label: S.queries, align: 'right', sortValue: r => r.queries_open,
            render: r => r.queries_open ? <StatusPill tone="warn">{S.queriesPill(r.queries_open)}</StatusPill> : '0' },
        ]} />}
    </>
  );
}

// ===================================================================================================================
// TRO-073 casebook
// ===================================================================================================================
interface ScheduleRow { visit_definition_id: string; code: string; name: string; planned_day: number | null; id: string | null; visit_date: string | null;
  status: string | null; completed_at: string | null; queries_open: number | null }
interface Casebook { id: string; subject_code: string; site_number: string; status: string; schedule: ScheduleRow[] }

export function EdcCasebook({ id }: { id: string }) {
  const s = useSession();
  const toast = useToast();
  const cb = useData<Casebook>(`/v1/edc/subjects/${id}`);
  const [starting, setStarting] = useState<ScheduleRow | null>(null);
  const [date, setDate] = useState(today());
  const C = T.casebook;
  if (cb.error) return <ErrorNote error={cb.error} />;
  if (!cb.data) return <Loading />;
  const d = cb.data;
  const site = s.can(...EDC_SITE_ROLES);
  return (
    <>
      <PageHeader crumbs={<a href="#/edc">{C.crumbs}</a>} title={C.title(d.subject_code)} subtitle={C.subtitle}
        facts={[[C.site, d.site_number], [C.status, human(d.status)]]} />
      <DataTable rows={d.schedule} rowKey={r => r.visit_definition_id} onRowClick={r => { if (r.id) go(`/edc/visits/${r.id}`); }} columns={[
        { key: 'code', label: C.visit, render: r => <span className="t-mono">{r.code}</span> },
        { key: 'name', label: C.name },
        { key: 'planned_day', label: C.day, align: 'right', render: r => r.planned_day ?? '—' },
        { key: 'visit_date', label: C.date, render: r => <span className="t-mono">{r.visit_date ?? '—'}</span> },
        { key: 'status', label: C.visitStatus, render: r => r.status ? <StatusPill tone={tone(r.status)}>{human(r.status)}</StatusPill>
          : site ? <Button onClick={e => { e.stopPropagation(); setDate(today()); setStarting(r); }}>{C.start}</Button> : C.notStarted },
        { key: 'queries_open', label: C.queries, align: 'right', render: r => r.queries_open ? <StatusPill tone="warn">{r.queries_open}</StatusPill> : '—' },
      ]} />
      {starting ? <Modal title={C.startTitle(starting.code)} onClose={() => setStarting(null)} actions={<>
          <Button onClick={() => setStarting(null)}>{C.cancel}</Button>
          <Button variant="primary" disabled={!date} onClick={() => api('POST', `/v1/edc/subjects/${d.id}/visits`, { body: { visit_definition_id: starting.visit_definition_id, visit_date: date } })
            .then(v => go(`/edc/visits/${v.id}`), e => toast((e as Error).message, true))}>{C.confirm}</Button></>}>
        <TextField label={C.dateLabel} type="date" value={date} max={today()} hint={C.dateHint} onChange={e => setDate(e.target.value)} />
      </Modal> : null}
    </>
  );
}

// ===================================================================================================================
// TRO-074 visit data entry
// ===================================================================================================================
interface ItemDef { id: string; oid: string; label: string; data_type: string; required: boolean; unit: string | null; terms: { value: string; decode: string }[] }
interface Value { id: string; item_oid: string; value: string | null; missing_reason: string | null; entered_by: string; entered_at: string }
interface FormBlock { form_id: string; oid: string; name: string; entry: { id: string; status: string; completed_at: string | null } | null;
  version: { id: string; version_no: number; items: ItemDef[] } | null; values: Value[]; queries: EdcQuery[] }
interface Visit { id: string; subject_id: string; subject_code: string; site_number: string; visit_code: string; visit_name: string; visit_date: string;
  status: string; completed_at: string | null; forms: FormBlock[] }

export function EdcVisit({ id }: { id: string }) {
  const s = useSession();
  const toast = useToast();
  const visit = useData<Visit>(`/v1/subject-visits/${id}`);
  const [completing, setCompleting] = useState(false);
  const V = T.visit;
  if (visit.error) return <ErrorNote error={visit.error} />;
  if (!visit.data) return <Loading />;
  const d = visit.data;
  const site = s.can(...EDC_SITE_ROLES);
  return (
    <>
      <PageHeader crumbs={<><a href="#/edc">{V.crumbs}</a> / <a href={`#/edc/subjects/${d.subject_id}`}>{d.subject_code}</a></>}
        title={V.title(d.subject_code, `${d.visit_code} ${d.visit_name}`)}
        facts={[[V.site, d.site_number], [V.date, d.visit_date], [V.status, human(d.status)], [V.completed, utc(d.completed_at)]]}
        actions={site && d.status === 'in_progress' ? <Button variant="primary" disabled={completing} onClick={() => {
          setCompleting(true);
          api('POST', `/v1/subject-visits/${d.id}/complete`).then(() => { toast(V.completedToast); visit.reload(); },
            e => toast((e as Error).message, true)).finally(() => setCompleting(false));
        }}>{V.completeVisit}</Button> : undefined} />
      {d.forms.map(f => <FormPanel key={f.form_id} visitId={d.id} form={f} canEnter={site && d.status !== 'void'} onChange={visit.reload} />)}
    </>
  );
}

function FormPanel({ visitId, form, canEnter, onChange }: { visitId: string; form: FormBlock; canEnter: boolean; onChange: () => void }) {
  const s = useSession();
  const toast = useToast();
  const V = T.visit;
  const saved = Object.fromEntries(form.values.map(v => [v.item_oid, v]));
  const initial = () => Object.fromEntries((form.version?.items ?? []).map(i => [i.oid, { value: saved[i.oid]?.value ?? '', missing: saved[i.oid]?.missing_reason ?? '' }]));
  const [draft, setDraft] = useState<Record<string, { value: string; missing: string }>>(initial);
  const [dialog, setDialog] = useState<null | 'reason' | 'reopen' | { answer: EdcQuery } | { close: EdcQuery }>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // a reload brings the saved values: the form shows them again
  useEffect(() => setDraft(initial()), [form.values]);
  const changed = Object.entries(draft).filter(([oid, x]) => (saved[oid]?.value ?? '') !== x.value || (saved[oid]?.missing_reason ?? '') !== x.missing);
  const changesSaved = changed.some(([oid]) => saved[oid]);
  const save = async (reason?: string) => {
    setBusy(true);
    try {
      const r = await api<{ queries_opened: number }>('PUT', `/v1/crf-entries/${form.entry!.id}/values`, { reason, body: { values: changed.map(([oid, x]) =>
        ({ item_oid: oid, value: x.missing ? null : (x.value || null), missing_reason: x.missing || null })) } });
      toast(r.queries_opened ? V.savedQueries(r.queries_opened) : V.saved);
      setDialog(null); onChange();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const act = (p: Promise<unknown>, done: string) => p.then(() => { toast(done); setDialog(null); setText(''); onChange(); }, e => toast((e as Error).message, true));
  const open = form.queries.filter(q => q.status === 'open' || q.status === 'answered').length;
  const editable = canEnter && !!form.entry;
  return (
    <Panel title={`${form.name} (${form.oid})`} meta={form.version ? V.version(form.version.version_no) : undefined}
      actions={<>
        {form.entry ? <StatusPill tone={tone(form.entry.status)}>{human(form.entry.status)}</StatusPill> : <span className="t-muted">{V.notStarted}</span>}
        {open ? <StatusPill tone="warn">{V.openQueries(open)}</StatusPill> : null}
        {canEnter && !form.entry ? <Button variant="primary" onClick={() => act(api('POST', `/v1/subject-visits/${visitId}/entries`, { body: { crf_form_id: form.form_id } }), V.formStarted)}>{V.startForm}</Button> : null}
        {editable && form.entry!.status === 'in_progress' ? <Button onClick={() => act(api('POST', `/v1/crf-entries/${form.entry!.id}/complete`), V.completeToast)}>{V.complete}</Button> : null}
        {editable && form.entry!.status === 'complete' ? <Button variant="ghost" onClick={() => setDialog('reopen')}>{V.reopen}</Button> : null}
      </>}>
      {form.entry && form.version ? <div className="stack">
        {form.version.items.map(i => {
          const x = draft[i.oid] ?? { value: '', missing: '' };
          const set = (patch: Partial<typeof x>) => setDraft({ ...draft, [i.oid]: { ...x, ...patch } });
          const label = `${i.label}${i.unit ? ` (${i.unit})` : ''}${i.required ? ` · ${V.required}` : ''}`;
          const itemQueries = form.queries.filter(q => q.item_oid === i.oid && (q.status === 'open' || q.status === 'answered'));
          return <div className="form-grid" key={i.oid} data-item={i.oid}>
            {i.data_type === 'coded'
              ? <SelectField label={label} value={x.value} disabled={!editable || !!x.missing} onChange={e => set({ value: e.target.value })}
                  options={[{ value: '', label: V.choose }, ...i.terms.map(t => ({ value: t.value, label: `${t.decode} (${t.value})` }))]} />
              : <TextField label={label} value={x.value} disabled={!editable || !!x.missing} hint={saved[i.oid] ? V.entered(saved[i.oid]!.entered_by, utc(saved[i.oid]!.entered_at)) : i.oid}
                  type={i.data_type === 'date' ? 'date' : 'text'} inputMode={i.data_type === 'integer' || i.data_type === 'decimal' ? 'decimal' : undefined}
                  onChange={e => set({ value: e.target.value })} />}
            <SelectField label={`${V.missing}: ${i.label}`} value={x.missing} disabled={!editable} onChange={e => set({ missing: e.target.value, value: e.target.value ? '' : x.value })}
              options={[{ value: '', label: V.missingNone }, ...Object.entries(V.missingOptions).map(([k, l]) => ({ value: k, label: l }))]} />
            {itemQueries.length ? <div className="stack-sm">{itemQueries.map(q => <span key={q.id} className="row">
              <StatusPill tone={queryTone(q.status)}>{human(q.status)}</StatusPill><span>{q.question}</span></span>)}</div> : <span />}
          </div>;
        })}
        {editable ? <div className="row"><Button variant="primary" disabled={!changed.length || busy}
          onClick={() => (changesSaved ? setDialog('reason') : void save())}>{V.save}</Button></div> : null}
      </div> : null}
      {form.entry ? <QueryList queries={form.queries} canAnswer={s.can(...EDC_SITE_ROLES)} canClose={s.can(...EDC_REVIEW_ROLES)}
        onAnswer={q => { setText(''); setDialog({ answer: q }); }} onClose={q => { setText(''); setDialog({ close: q }); }} /> : null}
      {dialog === 'reason' ? <ReasonDialog title={V.reasonTitle} description={V.reasonText} confirmLabel={V.reasonConfirm} onClose={() => setDialog(null)}
        onConfirm={reason => save(reason)} /> : null}
      {dialog === 'reopen' ? <ReasonDialog title={V.reopenTitle} confirmLabel={V.reopenConfirm} onClose={() => setDialog(null)}
        onConfirm={reason => act(api('POST', `/v1/crf-entries/${form.entry!.id}/reopen`, { reason }), V.reopen) as Promise<void>} /> : null}
      {dialog && typeof dialog === 'object' && 'answer' in dialog ? <Modal title={V.answerTitle} onClose={() => setDialog(null)} actions={<>
          <Button onClick={() => setDialog(null)}>{T.casebook.cancel}</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => act(api('POST', `/v1/edc-queries/${dialog.answer.id}/answer`, { body: { answer: text.trim() } }), V.answered)}>
            {V.answerConfirm}</Button></>}>
        <p>{dialog.answer.question}</p>
        <TextField label={V.answerLabel} value={text} onChange={e => setText(e.target.value)} />
      </Modal> : null}
      {dialog && typeof dialog === 'object' && 'close' in dialog ? <ReasonDialog title={V.closeTitle} description={dialog.close.question} confirmLabel={V.closeConfirm}
        onClose={() => setDialog(null)} onConfirm={reason => act(api('POST', `/v1/edc-queries/${dialog.close.id}/close`, { body: { reason } }), V.closedToast) as Promise<void>} /> : null}
    </Panel>
  );
}

export function QueryList({ queries, canAnswer, canClose, onAnswer, onClose }: { queries: EdcQuery[]; canAnswer: boolean; canClose: boolean;
  onAnswer: (q: EdcQuery) => void; onClose: (q: EdcQuery) => void }) {
  const V = T.visit;
  if (!queries.length) return <p className="t-muted">{V.noQueries}</p>;
  return <div className="stack-sm" aria-label={V.queries}>
    <strong>{V.queries}</strong>
    {queries.map(q => <div key={q.id} className="stack-sm" data-query={q.status}>
      <span className="row"><StatusPill tone={queryTone(q.status)}>{human(q.status)}</StatusPill>
        <span className="t-mono">{q.item_oid ?? '—'}</span><span>{q.question}</span>
        {canAnswer && q.status === 'open' ? <Button onClick={() => onAnswer(q)}>{V.answer}</Button> : null}
        {canClose && (q.status === 'open' || q.status === 'answered') ? <Button variant="ghost" onClick={() => onClose(q)}>{V.close}</Button> : null}</span>
      <DefinitionList items={[
        [V.origin, q.check_code ? V.byCheck(q.check_code) : V.manual],
        [V.openedK, V.opened(q.opened_by, utc(q.opened_at))],
        ...(q.answer ? [[V.answerK, V.answerLine(q.answer, q.answered_by)] as [string, string]] : []),
        ...(q.close_reason ? [[V.closedK, `${q.close_reason} · ${q.closed_by ?? ''} · ${utc(q.closed_at)}`] as [string, string]] : []),
      ]} />
    </div>)}
  </div>;
}
