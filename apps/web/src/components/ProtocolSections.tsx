// Structured editors and read views for the protocol sections (ICH M11 headings, USDM objects) — M01-01.
// Built only from the design system components; the schema lives in packages/schemas/protocol-sections.schema.json.
import { Button, Input, Select, Textarea, Field, DataTable, EmptyState } from '@trialops/shell';

export type Content = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Kind = 'text' | 'textarea' | 'select' | 'number' | 'csv';
interface Col { key: string; label: string; kind: Kind; options?: string[] }

const LEVELS = ['primary', 'secondary', 'exploratory'];
const STAGES = ['dose_finding', 'expansion', 'efficacy', 'confirmatory'];
export const SECTIONS: { key: string; title: string; m11: string; list?: Col[]; fields?: Col[]; sub?: { key: string; title: string; cols: Col[] }[] }[] = [
  { key: 'synopsis', title: 'Synopsis', m11: '1', fields: [{ key: 'title', label: 'Title', kind: 'text' }, { key: 'phase', label: 'Phase', kind: 'select', options: ['phase1', 'phase1_2', 'phase2', 'phase2_3', 'phase3'] }, { key: 'rationale', label: 'Rationale', kind: 'textarea' }] },
  { key: 'objectives', title: 'Objectives', m11: '3', list: [{ key: 'id', label: 'Id', kind: 'text' }, { key: 'level', label: 'Level', kind: 'select', options: LEVELS }, { key: 'text', label: 'Objective', kind: 'textarea' }, { key: 'endpoint_ids', label: 'Endpoints', kind: 'csv' }] },
  { key: 'endpoints', title: 'Endpoints', m11: '3', list: [{ key: 'id', label: 'Id', kind: 'text' }, { key: 'type', label: 'Type', kind: 'select', options: ['efficacy', 'safety', 'pharmacokinetic', 'pharmacodynamic', 'other'] }, { key: 'text', label: 'Endpoint', kind: 'textarea' }, { key: 'timeframe', label: 'Timeframe', kind: 'text' }] },
  { key: 'population', title: 'Trial population', m11: '5', fields: [{ key: 'description', label: 'Description', kind: 'textarea' }],
    sub: [{ key: 'inclusion', title: 'Inclusion criteria', cols: [{ key: 'id', label: 'Id', kind: 'text' }, { key: 'text', label: 'Criterion', kind: 'textarea' }] },
          { key: 'exclusion', title: 'Exclusion criteria', cols: [{ key: 'id', label: 'Id', kind: 'text' }, { key: 'text', label: 'Criterion', kind: 'textarea' }] }] },
  { key: 'interventions', title: 'Interventions', m11: '6', list: [{ key: 'id', label: 'Id', kind: 'text' }, { key: 'name', label: 'Name', kind: 'text' }, { key: 'type', label: 'Type', kind: 'select', options: ['drug', 'biologic', 'placebo', 'device', 'other'] }, { key: 'dose', label: 'Dose', kind: 'text' }, { key: 'route', label: 'Route', kind: 'text' }, { key: 'frequency', label: 'Frequency', kind: 'text' }] },
  { key: 'schedule', title: 'Schedule of activities', m11: '1.3', sub: [{ key: 'visits', title: 'Visits', cols: [{ key: 'id', label: 'Id', kind: 'text' }, { key: 'name', label: 'Visit', kind: 'text' }, { key: 'day', label: 'Day', kind: 'number' }, { key: 'window_days', label: '± days', kind: 'number' }, { key: 'activities', label: 'Activities', kind: 'csv' }] }] },
  { key: 'transition_rules', title: 'Adaptive transition rules', m11: '4', list: [{ key: 'id', label: 'Id', kind: 'text' }, { key: 'from_stage', label: 'From', kind: 'select', options: STAGES }, { key: 'to_stage', label: 'To', kind: 'select', options: [...STAGES, 'graduated', 'stopped'] }, { key: 'criterion', label: 'Criterion', kind: 'textarea' }] },
];

const show = (c: Col, v: unknown) => c.kind === 'csv' ? (Array.isArray(v) ? v.join(', ') : '') : v === undefined || v === null || v === '' ? '—' : String(v).replace(/_/g, ' ');

function Control({ col, value, onChange, label }: { col: Col; value: unknown; onChange: (v: unknown) => void; label: string }) {
  const common = { 'aria-label': label };
  if (col.kind === 'select') return <Select {...common} value={String(value ?? '')} onChange={e => onChange(e.target.value)}><option value="">—</option>{col.options!.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</Select>;
  if (col.kind === 'textarea') return <Textarea {...common} rows={2} value={String(value ?? '')} onChange={e => onChange(e.target.value)} />;
  if (col.kind === 'number') return <Input {...common} type="number" value={value === undefined || value === null ? '' : String(value)} onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  if (col.kind === 'csv') return <Input {...common} value={Array.isArray(value) ? value.join(', ') : ''} onChange={e => onChange(e.target.value.split(',').map(x => x.trim()).filter(Boolean))} />;
  return <Input {...common} value={String(value ?? '')} onChange={e => onChange(e.target.value)} />;
}

function ListEditor({ cols, rows, onChange, editing }: { cols: Col[]; rows: Content[]; onChange: (rows: Content[]) => void; editing: boolean }) {
  if (!editing) return <DataTable rows={rows.map((r, i) => ({ ...r, __k: `${i}` }))} rowKey={r => r.__k}
    columns={cols.map(c => ({ key: c.key, label: c.label, wrap: c.kind === 'textarea' || c.kind === 'csv', render: (r: Content) => show(c, r[c.key]) }))} empty={<EmptyState title="Not specified" />} />;
  return (
    <div className="stack-sm">
      {rows.map((r, i) => (
        <div className="form-grid" key={i}>
          {cols.map(c => <Control key={c.key} col={c} label={`${c.label} ${i + 1}`} value={r[c.key]} onChange={v => onChange(rows.map((x, j) => j === i ? { ...x, [c.key]: v } : x))} />)}
          <Button variant="danger" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
        </div>))}
      <div><Button onClick={() => onChange([...rows, {}])}>Add row</Button></div>
    </div>
  );
}

/** Read or edit one section. `value` is the section content; onChange returns the new content. */
export function SectionEditor({ sectionKey, value, onChange, editing }: { sectionKey: string; value: unknown; onChange: (v: unknown) => void; editing: boolean }) {
  const def = SECTIONS.find(s => s.key === sectionKey)!;
  if (def.list) return <ListEditor cols={def.list} rows={(value as Content[]) ?? []} onChange={onChange} editing={editing} />;
  const obj = (value as Content) ?? {};
  return (
    <div className="stack">
      {def.fields?.map(f => editing
        ? <Field key={f.key} label={f.label}><Control col={f} label={f.label} value={obj[f.key]} onChange={v => onChange({ ...obj, [f.key]: v })} /></Field>
        : <div key={f.key} className="stack-sm"><span className="t-muted">{f.label}</span><span>{show(f, obj[f.key])}</span></div>)}
      {def.sub?.map(s => <div className="stack-sm" key={s.key}><strong>{s.title}</strong>
        <ListEditor cols={s.cols} rows={(obj[s.key] as Content[]) ?? []} editing={editing} onChange={rows => onChange({ ...obj, [s.key]: rows })} /></div>)}
    </div>
  );
}

/** Removes empty optional values so the content validates against the schema. */
export function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== undefined && x !== null).map(([k, x]) => [k, clean(x)]));
  return v;
}
