// Pure rules of "Suggest changes" (UX-01): which boxes of a page are components, their stable code and the reading
// order. Kept free of the DOM so they are unit-tested; SuggestChanges.tsx measures the page and calls these.

export type ComponentKind = 'table' | 'card' | 'heading' | 'toolbar' | 'chart' | 'field' | 'section' | 'component';

/** Most components numbered at once: beyond this the numbers hide the page instead of pointing into it. */
export const SUGGEST_MAX = 90;
const CODE = /^[A-Z]{2,4}-\d{3}\.C\d{2,3}$/;

/** `<PAGE CODE>.Cnn` (e.g. TRO-010.C04). An explicit data-fc code on the element wins when it is well formed. */
export function componentCode(pageCode: string, n: number, explicit?: string | null): string {
  if (explicit && CODE.test(explicit.trim())) return explicit.trim();
  return `${pageCode}.C${String(n).padStart(2, '0')}`;
}

/** What the page measured about one element (computed style and box). */
export interface BoxInfo {
  tag: string;                 // lower case
  explicit: boolean;           // has data-fc
  explicitKind?: string | null; // data-fc-kind
  shellKind?: ComponentKind | null; // a shell component recognised by its class (.panel, .figure, .table-wrap …)
  width: number; height: number; rootWidth: number;
  display: string;
  controls: number;            // direct children that are buttons, selects or inputs
  inTable: boolean; inButton: boolean;
  radius: number; outlined: boolean;
  fontSize: number; fontWeight: number; textLength: number; childCount: number;
  ownBackground: boolean; ruled: boolean;
}

const KINDS: ComponentKind[] = ['table', 'card', 'heading', 'toolbar', 'chart', 'field', 'section', 'component'];

/** The kind of component a box is, or null when it is not one (layout wrappers, text, cells, buttons). */
export function classifyBox(b: BoxInfo): ComponentKind | null {
  if (b.explicit) return KINDS.includes(b.explicitKind as ComponentKind) ? b.explicitKind as ComponentKind : 'component';
  if (b.width < 4 || b.height < 4) return null;
  if (b.tag === 'table') return 'table';
  if (/^h[1-3]$/.test(b.tag)) return 'heading';
  if (b.tag === 'svg' || b.tag === 'canvas') return b.width >= 120 && b.height >= 60 && !b.inButton ? 'chart' : null;
  if (b.tag === 'select' || b.tag === 'textarea' || b.tag === 'input') return b.inTable ? null : 'field';
  if (b.inButton) return null;
  if (b.shellKind) return b.inTable ? null : b.shellKind;
  // toolbars: a flex row with at least two controls side by side
  if (b.display.includes('flex') && b.controls >= 2 && b.height < 90 && !b.inTable) return 'toolbar';
  if (b.inTable) return null;
  // cards: rounded, outlined or shadowed boxes of a meaningful size
  if (b.radius >= 6 && b.outlined && b.width >= 140 && b.height >= 48) return 'card';
  // titles that are not h1–h3: large, bold, short text
  if (b.childCount <= 1 && b.fontSize >= 17 && b.fontWeight >= 600 && b.textLength >= 2 && b.textLength <= 80) return 'heading';
  // bands: wide strips with their own background or a rule (summary bars, filter rows)
  if ((b.ownBackground || b.ruled) && b.width >= Math.max(240, b.rootWidth * 0.6) && b.height >= 24 && b.height <= 220) return 'section';
  return null;
}

export interface Rect { top: number; left: number; width: number; height: number }
export interface Candidate<T> { item: T; rect: Rect }

/** Drops a box that only wraps another candidate of (almost) the same size, keeps reading order (top, then left) and
 * the first SUGGEST_MAX. `contains(a, b)`: a is an ancestor of b. */
export function orderComponents<T>(list: Candidate<T>[], contains: (a: T, b: T) => boolean, max = SUGGEST_MAX): Candidate<T>[] {
  const same = (a: Rect, b: Rect) => Math.abs(a.width - b.width) < 8 && Math.abs(a.height - b.height) < 8;
  return list
    .filter(c => !list.some(o => o !== c && contains(c.item, o.item) && same(c.rect, o.rect)))
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    .slice(0, max);
}

/** Visible text of a component as stored with the request: spaces collapsed, at most 120 characters. */
export function snippet(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export interface ChangeRequestRow {
  id: string; page_code: string; component_code: string | null; component_kind: string | null; component_text: string | null;
  dom_path: string | null; route: string | null; kind: string; request: string; status: string; triage_note: string;
  created_by: string; created_email: string | null; created_at: string;
}

/** "Copy as task": the request as a Markdown brief for Claude or Local Dev (project slug of TrialOps). */
export function changeRequestAsTask(r: ChangeRequestRow, project = 'trialops'): string {
  return [
    `# Change request ${r.id.slice(0, 8)} — ${r.component_code ?? r.page_code}`,
    '',
    `project: ${project}`,
    `page: ${r.page_code} · component: ${r.component_code ?? '—'} (${r.component_kind ?? '—'})`,
    r.component_text ? `component text: "${r.component_text}"` : null,
    r.dom_path ? `DOM path: ${r.dom_path}` : null,
    `route: ${r.route || '—'}`,
    `type: ${r.kind} · requested by ${r.created_email ?? r.created_by} on ${String(r.created_at).slice(0, 10)} (UTC) · status: ${r.status}`,
    '',
    '## Goal',
    r.request,
    r.triage_note ? `\n## Triage note\n${r.triage_note}` : null,
  ].filter(x => x !== null).join('\n');
}
