// Section diff of structured protocol content, shown before a person signs (AI-05).
import type { ReactNode } from 'react';

export interface SectionDiff {
  section: string; change: 'added' | 'removed' | 'changed';
  items?: { id: string; change: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }[];
  before?: unknown; after?: unknown;
}

const summary = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.text ?? o.title ?? o.name ?? o.description ?? Object.keys(o).join(', '));
  }
  return String(v);
};
const verb = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;

export function DiffList({ sections, render }: { sections: SectionDiff[]; render?: (section: string, value: unknown) => ReactNode }) {
  if (!sections.length) return <p className="t-muted">No differences.</p>;
  return (
    <div className="diff">{sections.flatMap(s => s.items?.length
      ? s.items.map(i => <div key={`${s.section}.${i.id}`} className={`diff-item ${i.change}`}>
          <span className="label">{verb[i.change]} · {s.section} · {i.id}</span><span>{summary(i.after ?? i.before)}</span></div>)
      : [<div key={s.section} className={`diff-item ${s.change}`}>
          <span className="label">{verb[s.change]} · {s.section}</span>
          {render ? render(s.section, s.after ?? s.before) : <Detail value={s.after ?? s.before} />}</div>])}
    </div>
  );
}

/** Whole-section change: list every item (id + text) so the signer reads the content, not a count. */
function Detail({ value }: { value: unknown }) {
  const lines: string[] = [];
  const walk = (v: unknown, prefix = '') => {
    if (Array.isArray(v)) v.forEach(x => {
      const o = (x ?? {}) as Record<string, unknown>;
      lines.push(`${prefix}${o.id ? `${o.id} · ` : ''}${summary(x)}`);
    });
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (Array.isArray(x)) { lines.push(`${k.replace(/_/g, ' ')}:`); walk(x, '  '); } else lines.push(`${k.replace(/_/g, ' ')}: ${summary(x)}`);
    }
    else lines.push(summary(v));
  };
  walk(value);
  return <ul className="diff-lines">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>;
}
