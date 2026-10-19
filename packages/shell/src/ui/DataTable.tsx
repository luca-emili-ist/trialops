// Data table with sticky header and sortable columns (house standard: sticky headers, sortable tables everywhere).
import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from './basic.tsx';
import { useT } from '../i18n.tsx';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null;
  align?: 'left' | 'right';
  /** Long text that may wrap; other cells stay on one line (codes, dates, numbers, pills). */
  wrap?: boolean;
}

/** `caption`: visible caption; `label`: accessible name of the scrollable table region when the panel title names it already. */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, selectedKey, empty, caption, label }: {
  columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void; selectedKey?: string | null;
  empty?: ReactNode; caption?: string; label?: string;
}) {
  const t = useT();
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    const val = (r: T) => col?.sortValue ? col.sortValue(r) : (r as Record<string, unknown>)[sort.key] as string | number | null;
    return [...rows].sort((a, b) => {
      const x = val(a); const y = val(b);
      if (x === y) return 0; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
  }, [rows, sort, columns]);
  if (!rows.length) return <>{empty ?? <EmptyState title={t('Nothing here yet')} />}</>;
  return (
    // scrollable region: reachable and scrollable with the keyboard (WCAG 2.1.1), named by its caption when there is one
    <div className="table-wrap" tabIndex={0} role="region" aria-label={label ?? caption ?? t('Table')}>
      <table className="table">
        {caption ? <caption className="table-caption">{caption}</caption> : null}
        <thead><tr>{columns.map(c => {
          const dir = sort?.key === c.key ? sort.dir : 0;
          return (
            <th key={c.key} className={c.align === 'right' ? 'num' : undefined} aria-sort={dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none'}>
              <button onClick={() => setSort(dir === 1 ? { key: c.key, dir: -1 } : dir === -1 ? null : { key: c.key, dir: 1 })}>
                {c.label}<span aria-hidden="true">{dir === 1 ? '▲' : dir === -1 ? '▼' : ''}</span>
              </button>
            </th>);
        })}</tr></thead>
        <tbody>{sorted.map(r => {
          const k = rowKey(r);
          return (
            <tr key={k} data-clickable={onRowClick ? 'true' : undefined} aria-selected={selectedKey === k ? true : undefined}
              tabIndex={onRowClick ? 0 : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? e => { if (e.key === 'Enter') onRowClick(r); } : undefined}>
              {columns.map(c => <td key={c.key} className={[c.align === 'right' ? 'num' : '', c.wrap ? 'wrap' : ''].join(' ').trim() || undefined}>
                {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '—')}</td>)}
            </tr>);
        })}</tbody>
      </table>
    </div>
  );
}
