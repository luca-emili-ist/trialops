// TRO-072 EDC subjects, TRO-073 subject casebook, TRO-074 visit data entry (EDC-03, EDC-04, EDC-05, EDC-11, EDC-12).
// The site enters typed values or a missing-data reason; the database stamps author and server UTC time, runs the edit
// checks on save (soft: a query opens, hard: the value is refused) and keeps every prior value with its reason.
// Blinded by construction: the API never returns the allocation, and these pages never ask for it.
import { useEffect, useState } from 'react';
import { PageHeader, Panel, DataTable, StatusPill, Button, Loading, ErrorNote, EmptyState, Modal, TextField, SelectField, ReasonDialog,
  DefinitionList, useToast, useT } from '@trialops/shell';
import { api } from '../api.ts';
import { useData, useSession } from '../session.tsx';
import { go } from '../router.ts';
import { human, tone } from '../format.ts';
import { EDC_REVIEW_ROLES, EDC_SITE_ROLES, queryTone, today, utc, type EdcQuery } from '../components/edc.ts';

// UI strings of these three pages, kept together and translated through t() (NFR-07, rule 15: site-facing pages in English
// and Japanese; the Japanese is in apps/web/src/i18n/ja.ts). Record content (item labels, questions, answers) is not translated.
type Tr = (text: string, vars?: Record<string, string | number>) => string;
const T = (t: Tr) => ({
  subjects: {
    title: t('Data entry'), subtitle: t('Subjects of your sites with their visits and open data queries. Treatment allocation is never shown here (blinded).'),
    code: t('Subject'), site: t('Site'), status: t('Status'), visits: t('Visits completed'), queries: t('Open queries'),
    empty: t('No subject in data entry for your sites'), table: t('Subjects in data entry'),
    queriesPill: (n: number) => t('{n} open', { n }),
  },
  casebook: {
    crumbs: t('Data entry'), title: (code: string) => t('Subject {code}', { code }), subtitle: t('Visit schedule of the Master Protocol and the visits recorded for this subject.'),
    site: t('Site'), status: t('Status'), visit: t('Visit'), name: t('Name'), day: t('Planned day'), date: t('Visit date'), visitStatus: t('Visit status'),
    queries: t('Open queries'), table: t('Visit schedule'),
    notStarted: t('not started'), start: t('Start visit'), startTitle: (code: string) => t('Start visit {code}', { code }),
    dateLabel: t('Visit date'), dateHint: t('Date of the visit at the site; it cannot be in the future (UTC).'), cancel: t('Cancel'), confirm: t('Start visit'),
  },
  visit: {
    crumbs: t('Data entry'), title: (subject: string, visit: string) => `${subject} · ${visit}`, site: t('Site'), date: t('Visit date'), status: t('Status'),
    completed: t('Completed'), completeVisit: t('Complete visit'), completedToast: t('Visit completed: data available (visit.completed)'),
    startForm: t('Start form'), formStarted: t('Form started'), notStarted: t('Not started'),
    openQueries: (n: number) => (n === 1 ? t('1 open query') : t('{n} open queries', { n })), version: (n: number) => t('CRF version {n}', { n }),
    value: t('Value'), missing: t('Missing data'), missingNone: '—',
    missingOptions: { ND: t('ND · not done'), NA: t('NA · not applicable'), UNK: t('UNK · unknown') },
    missingFor: (label: string) => t('Missing data: {label}', { label }),
    entered: (by: string, at: string) => t('Entered by {by} · {at}', { by, at }), required: t('required'), choose: t('— choose —'),
    save: t('Save'), saved: t('Saved'),
    savedQueries: (n: number) => (n === 1 ? t('Saved: 1 edit check query opened') : t('Saved: {n} edit check queries opened', { n })),
    reasonTitle: t('Reason for changing saved values'), reasonText: t('The previous values stay in the audit trail with this reason.'), reasonConfirm: t('Save changes'),
    complete: t('Mark form complete'), completeToast: t('Form complete'), reopen: t('Reopen form'), reopenTitle: t('Reopen the form'), reopenConfirm: t('Reopen'),
    reopened: t('Form reopened'),
    queries: t('Data queries'), noQueries: t('No queries on this form'), answer: t('Answer'), answerTitle: t('Answer the query'), answerLabel: t('Answer'),
    answerConfirm: t('Send answer'), answered: t('Answer sent'), close: t('Close'), closeTitle: t('Close the query'), closeConfirm: t('Close query'), closedToast: t('Query closed'),
    opened: (by: string, at: string) => t('Opened by {by} · {at}', { by, at }), byCheck: (code: string) => t('edit check {code}', { code }), manual: t('manual query'),
    answerLine: (a: string, by: string | null) => `${a}${by ? ` (${by})` : ''}`,
    origin: t('Origin'), openedK: t('Opened'), answerK: t('Answer'), closedK: t('Closed'),
  },
});

// ===================================================================================================================
// TRO-072 subjects
// ===================================================================================================================
interface SubjectRow { id: string; subject_code: string; site_number: string; status: string; visits: number; visits_completed: number; queries_open: number }

export function EdcSubjects() {
  const { platform } = useSession();
  const list = useData<{ items: SubjectRow[] }>(platform ? `/v1/platforms/${platform.id}/edc/subjects` : null);
  const t = useT();
  const S = T(t).subjects;
  return (
    <>
      <PageHeader title={S.title} subtitle={S.subtitle} />
      {list.error ? <ErrorNote error={list.error} /> : !list.data ? <Loading /> :
        <DataTable label={S.table} rows={list.data.items} rowKey={r => r.id} onRowClick={r => go(`/edc/subjects/${r.id}`)} empty={<EmptyState title={S.empty} />} columns={[
          { key: 'subject_code', label: S.code, render: r => <span className="t-mono">{r.subject_code}</span> },
          { key: 'site_number', label: S.site },
          { key: 'status', label: S.status, render: r => t(human(r.status)) },
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
  const t = useT();
  const C = T(t).casebook;
  if (cb.error) return <ErrorNote error={cb.error} />;
  if (!cb.data) return <Loading />;
  const d = cb.data;
  const site = s.can(...EDC_SITE_ROLES);
  return (
    <>
      <PageHeader crumbs={<a href="#/edc">{C.crumbs}</a>} title={C.title(d.subject_code)} subtitle={C.subtitle}
        facts={[[C.site, d.site_number], [C.status, t(human(d.status))]]} />
      <DataTable label={C.table} rows={d.schedule} rowKey={r => r.visit_definition_id} onRowClick={r => { if (r.id) go(`/edc/visits/${r.id}`); }} columns={[
        { key: 'code', label: C.visit, render: r => <span className="t-mono">{r.code}</span> },
        { key: 'name', label: C.name },
        { key: 'planned_day', label: C.day, align: 'right', render: r => r.planned_day ?? '—' },
        { key: 'visit_date', label: C.date, render: r => <span className="t-mono">{r.visit_date ?? '—'}</span> },
        { key: 'status', label: C.visitStatus, render: r => r.status ? <StatusPill tone={tone(r.status)}>{t(human(r.status))}</StatusPill>
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
  const t = useT();
  const V = T(t).visit;
  if (visit.error) return <ErrorNote error={visit.error} />;
  if (!visit.data) return <Loading />;
  const d = visit.data;
  const site = s.can(...EDC_SITE_ROLES);
  return (
    <>
      <PageHeader crumbs={<><a href="#/edc">{V.crumbs}</a> / <a href={`#/edc/subjects/${d.subject_id}`}>{d.subject_code}</a></>}
        title={V.title(d.subject_code, `${d.visit_code} ${d.visit_name}`)}
        facts={[[V.site, d.site_number], [V.date, d.visit_date], [V.status, t(human(d.status))], [V.completed, utc(d.completed_at)]]}
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
  const t = useT();
  const V = T(t).visit;
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
        {form.entry ? <StatusPill tone={tone(form.entry.status)}>{t(human(form.entry.status))}</StatusPill> : <span className="t-muted">{V.notStarted}</span>}
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
                  options={[{ value: '', label: V.choose }, ...i.terms.map(term => ({ value: term.value, label: `${term.decode} (${term.value})` }))]} />
              : <TextField label={label} value={x.value} disabled={!editable || !!x.missing} hint={saved[i.oid] ? V.entered(saved[i.oid]!.entered_by, utc(saved[i.oid]!.entered_at)) : i.oid}
                  type={i.data_type === 'date' ? 'date' : 'text'} inputMode={i.data_type === 'integer' || i.data_type === 'decimal' ? 'decimal' : undefined}
                  onChange={e => set({ value: e.target.value })} />}
            <SelectField label={V.missingFor(i.label)} value={x.missing} disabled={!editable} onChange={e => set({ missing: e.target.value, value: e.target.value ? '' : x.value })}
              options={[{ value: '', label: V.missingNone }, ...Object.entries(V.missingOptions).map(([k, l]) => ({ value: k, label: l }))]} />
            {itemQueries.length ? <div className="stack-sm">{itemQueries.map(q => <span key={q.id} className="row">
              <StatusPill tone={queryTone(q.status)}>{t(human(q.status))}</StatusPill><span>{q.question}</span></span>)}</div> : <span />}
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
        onConfirm={reason => act(api('POST', `/v1/crf-entries/${form.entry!.id}/reopen`, { reason }), V.reopened) as Promise<void>} /> : null}
      {dialog && typeof dialog === 'object' && 'answer' in dialog ? <Modal title={V.answerTitle} onClose={() => setDialog(null)} actions={<>
          <Button onClick={() => setDialog(null)}>{T(t).casebook.cancel}</Button>
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
  const t = useT();
  const V = T(t).visit;
  if (!queries.length) return <p className="t-muted">{V.noQueries}</p>;
  return <div className="stack-sm" aria-label={V.queries}>
    <strong>{V.queries}</strong>
    {queries.map(q => <div key={q.id} className="stack-sm" data-query={q.status}>
      <span className="row"><StatusPill tone={queryTone(q.status)}>{t(human(q.status))}</StatusPill>
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
