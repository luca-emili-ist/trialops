// Section-level diff of structured protocol content, shown to the reviewer before signing (M01-02, AI-05).
import { canonical } from './canonical.ts';

export interface SectionDiff {
  section: string;
  change: 'added' | 'removed' | 'changed';
  items?: { id: string; change: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }[];
  before?: unknown;
  after?: unknown;
}

const byId = (a: unknown): Map<string, unknown> | null =>
  Array.isArray(a) && a.every(x => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string')
    ? new Map(a.map(x => [(x as { id: string }).id, x])) : null;

export function diffContent(before: Record<string, unknown> = {}, after: Record<string, unknown> = {}): SectionDiff[] {
  const out: SectionDiff[] = [];
  for (const section of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[section]; const a = after[section];
    if (b === undefined) { out.push({ section, change: 'added', after: a }); continue; }
    if (a === undefined) { out.push({ section, change: 'removed', before: b }); continue; }
    if (canonical(a) === canonical(b)) continue;
    const mb = byId(b); const ma = byId(a);
    if (mb && ma) {
      const items: NonNullable<SectionDiff['items']> = [];
      for (const id of [...new Set([...mb.keys(), ...ma.keys()])]) {
        const x = mb.get(id); const y = ma.get(id);
        if (x === undefined) items.push({ id, change: 'added', after: y });
        else if (y === undefined) items.push({ id, change: 'removed', before: x });
        else if (canonical(x) !== canonical(y)) items.push({ id, change: 'changed', before: x, after: y });
      }
      out.push({ section, change: 'changed', items });
    } else {
      out.push({ section, change: 'changed', before: b, after: a });
    }
  }
  return out;
}
