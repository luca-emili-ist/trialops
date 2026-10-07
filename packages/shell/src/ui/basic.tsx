// Base components of the TrialOps design system. Pages use only these (docs/DESIGN.md).
import { useId, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Variant = 'sign' | 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" {...rest} className={`btn btn-${variant} ${rest.className ?? ''}`} />;
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error ? <span className="hint">{hint}</span> : null}
      {error ? <span className="error" role="alert">{error}</span> : null}
    </div>
  );
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) { return <input {...p} className={`input ${p.className ?? ''}`} />; }
export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...p} className={`select ${p.className ?? ''}`} />; }
export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...p} className={`textarea ${p.className ?? ''}`} />; }

/** Labelled control with a generated id. */
export function TextField({ label, hint, error, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return <Field label={label} hint={hint} error={error} htmlFor={input.id ?? id}><Input id={input.id ?? id} aria-invalid={!!error} {...input} /></Field>;
}
export function SelectField({ label, hint, options, ...select }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; options: { value: string; label: string }[] }) {
  const id = useId();
  return <Field label={label} hint={hint} htmlFor={select.id ?? id}><Select id={select.id ?? id} {...select}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Panel({ title, actions, meta, children }: { title?: ReactNode; actions?: ReactNode; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {title || actions ? <div className="panel-head">{title ? <h2>{title}</h2> : <span />}{actions ? <div className="row">{actions}</div> : null}</div> : null}
      {children}
      {meta ? <div className="panel-meta">{meta}</div> : null}
    </section>
  );
}

export function PageHeader({ title, subtitle, crumbs, actions }: { title: ReactNode; subtitle?: ReactNode; crumbs?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>{crumbs ? <div className="crumbs">{crumbs}</div> : null}<h1>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}

export function KeyFigures({ items }: { items: { label: string; value: ReactNode; note?: ReactNode }[] }) {
  return <div className="figures">{items.map(i => <div className="figure" key={i.label}><span>{i.label}</span><strong>{i.value}</strong>{i.note ? <small>{i.note}</small> : null}</div>)}</div>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children ? <span>{children}</span> : null}{action}</div>;
}

/** Measured value against interim and final targets (lower is better unless `higherIsBetter`). */
export function MetricBar({ value, interim, final, max }: { value: number | null; interim: number | null; final: number | null; max?: number }) {
  const top = max ?? (Math.max(value ?? 0, interim ?? 0, final ?? 0) * 1.15 || 1);
  const pct = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  return (
    <div className="metric-bar" role="img" aria-label={`value ${value ?? 'no data'}, interim target ${interim ?? '—'}, final target ${final ?? '—'}`}>
      {value !== null ? <i style={{ width: pct(value) }} /> : null}
      {interim !== null ? <b style={{ left: pct(interim) }} title={`Interim target ${interim}`} /> : null}
      {final !== null ? <b className="final" style={{ left: pct(final) }} title={`Final target ${final}`} /> : null}
    </div>
  );
}

export function Steps({ steps }: { steps: { label: string; value: ReactNode; state: 'done' | 'current' | 'todo' }[] }) {
  return <ol className="steps">{steps.map(s =>
    <li className="step" key={s.label} data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}><span>{s.label}</span><strong>{s.value}</strong></li>)}</ol>;
}

export function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return <dl className="dl">{items.map(([k, v]) => [<dt key={`t${k}`}>{k}</dt>, <dd key={`d${k}`}>{v}</dd>])}</dl>;
}
