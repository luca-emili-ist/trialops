// "Suggest changes" (UX-01): a button top right switches the page into suggestion mode. Every component of the page (or
// of the open modal) gets a number; its stable code is <PAGE CODE>.Cnn from the page-code registry, or the data-fc code
// the component declares. Clicking a number opens a panel to describe the change; the application stores it (UX-02).
import { useCallback, useEffect, useState } from 'react';
import { Button, StatusPill, Textarea } from './basic.tsx';
import { useT } from '../i18n.tsx';
import { classifyBox, componentCode, orderComponents, snippet, type ComponentKind } from './suggest.ts';

export interface SuggestedChange { page_code: string; component_code: string; component_kind: ComponentKind; component_text: string;
  dom_path: string; route: string; kind: 'change' | 'bug' | 'new'; request: string }
export interface OpenRequest { id: string; component_code: string | null; request: string; status: string }

interface Item { el: Element; code: string; kind: ComponentKind; n: number; explicit: boolean }

const UI = '[data-suggest-ui]';
// Shell components recognised by their class: their glass surfaces have no solid background to measure.
const SHELL: [string, ComponentKind][] = [['.table-wrap', 'table'], ['.panel', 'card'], ['.figure', 'card'], ['.process', 'section'],
  ['.steps', 'section'], ['.attention-item', 'card'], ['.page-header', 'section'], ['.empty', 'card'], ['.dl', 'section']];
const SELECTOR = '[data-fc], table, h1, h2, h3, svg, canvas, select, textarea, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), div, section, form, header, dl, ol';

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

/** The open modal, if any: then only its content is numbered. */
function topLayer(): Element | null {
  const modals = [...document.querySelectorAll('.modal-backdrop .modal')].filter(m => !m.closest(UI) && visible(m));
  return modals.at(-1) ?? null;
}

function domPath(el: Element): string {
  const parts: string[] = [];
  let n: Element | null = el;
  while (n && n !== document.body && parts.length < 10) {
    const tag = n.tagName.toLowerCase();
    const same: Element[] = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
    n = n.parentElement;
  }
  return parts.join(' > ');
}

function textOf(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return snippet(el.placeholder || el.getAttribute('aria-label') || el.name);
  if (el instanceof HTMLSelectElement) return snippet(el.options[el.selectedIndex]?.text);
  return snippet((el as HTMLElement).innerText || el.textContent);
}

function collect(scope: Element | null, pageCode: string): Item[] {
  const root = scope ?? document.querySelector('main') ?? document.body;
  const rootWidth = root.getBoundingClientRect().width || window.innerWidth;
  const found: { item: Element; rect: DOMRect; kind: ComponentKind }[] = [];
  root.querySelectorAll(SELECTOR).forEach(el => {
    if (el.closest(UI) || !visible(el)) return;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const parentBg = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : '';
    const bg = cs.backgroundColor;
    const kind = classifyBox({
      tag: el.tagName.toLowerCase(), explicit: el.hasAttribute('data-fc'), explicitKind: el.getAttribute('data-fc-kind'),
      shellKind: SHELL.find(([sel]) => el.matches(sel))?.[1] ?? null,
      width: r.width, height: r.height, rootWidth, display: cs.display,
      controls: [...el.children].filter(c => /^(BUTTON|SELECT|INPUT)$/.test(c.tagName)).length,
      inTable: !!el.parentElement?.closest('table'), inButton: !!el.closest('button'),
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      outlined: (parseFloat(cs.borderTopWidth) || 0) > 0 || (!!cs.boxShadow && cs.boxShadow !== 'none'),
      fontSize: parseFloat(cs.fontSize) || 0, fontWeight: parseInt(cs.fontWeight, 10) || 400,
      textLength: (el.textContent ?? '').trim().length, childCount: el.childElementCount,
      ownBackground: !!bg && !/,\s*0\)$/.test(bg) && bg !== 'transparent' && bg !== parentBg,   // alpha 0 = no background of its own
      ruled: (parseFloat(cs.borderBottomWidth) || 0) > 0 || (parseFloat(cs.borderTopWidth) || 0) > 0,
    });
    if (kind) found.push({ item: el, rect: r, kind });
  });
  const kinds = new Map(found.map(f => [f.item, f.kind]));
  const ordered = orderComponents(found.map(f => ({ item: f.item, rect: { top: f.rect.top + window.scrollY, left: f.rect.left, width: f.rect.width, height: f.rect.height } })),
    (a, b) => a.contains(b));
  return ordered.map((c, i) => ({ el: c.item, kind: kinds.get(c.item)!, n: i + 1, explicit: c.item.hasAttribute('data-fc'),
    code: componentCode(pageCode, i + 1, c.item.getAttribute('data-fc')) }));
}

function Icon() {
  return <svg className="suggest-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M12 7v6M9 10h6" /></svg>;
}

/** The button and, when active, the numbered overlay. `onSubmit` stores the suggestion; `loadOpen` lists the requests still
 * open on a page. Mounted by the application only for a signed-in person. */
export function SuggestChanges({ pageCode, onSubmit, loadOpen, triageHint = 'Change requests' }: {
  pageCode: string; onSubmit: (c: SuggestedChange) => Promise<void>; loadOpen: (pageCode: string) => Promise<OpenRequest[]>; triageHint?: string;
}) {
  const t = useT();
  const [active, setActive] = useState(false);
  useEffect(() => { setActive(false); }, [pageCode]);
  return (
    <>
      <button type="button" data-suggest-ui className="suggest-btn" aria-pressed={active} onClick={() => setActive(a => !a)}
        title={t('Suggest changes: number the components of this page and describe what should change')} aria-label={t('Suggest changes')}>
        <Icon /><span className="suggest-label">{t('Suggest changes')}</span>
      </button>
      {active ? <SuggestOverlay pageCode={pageCode} onExit={() => setActive(false)} onSubmit={onSubmit} loadOpen={loadOpen} triageHint={triageHint} /> : null}
    </>
  );
}

function SuggestOverlay({ pageCode, onExit, onSubmit, loadOpen, triageHint }: { pageCode: string; onExit: () => void; triageHint: string;
  onSubmit: (c: SuggestedChange) => Promise<void>; loadOpen: (pageCode: string) => Promise<OpenRequest[]> }) {
  const t = useT();
  const [items, setItems] = useState<Item[]>([]);
  const [inModal, setInModal] = useState(false);
  const [hover, setHover] = useState<Item | null>(null);
  const [picked, setPicked] = useState<Item | null>(null);
  const [, setTick] = useState(0);
  const scan = useCallback(() => { const layer = topLayer(); setInModal(!!layer); setItems(collect(layer, pageCode)); setPicked(null); }, [pageCode]);

  useEffect(() => {
    scan();
    let raf = 0;
    const redraw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setTick(t => t + 1)); };
    window.addEventListener('scroll', redraw, true);
    window.addEventListener('resize', redraw);
    return () => { window.removeEventListener('scroll', redraw, true); window.removeEventListener('resize', redraw); cancelAnimationFrame(raf); };
  }, [scan]);
  useEffect(() => {
    // capture phase on window: runs before the Escape handler of an open modal
    const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; e.stopPropagation(); e.preventDefault(); if (picked) setPicked(null); else onExit(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picked, onExit]);

  const hoverRect = hover?.el.isConnected ? hover.el.getBoundingClientRect() : null;
  return (
    <div data-suggest-ui className="suggest-layer">
      <div className="suggest-bar" role="toolbar" aria-label={t('Suggestion mode')}>
        <span><b className="t-mono">{pageCode}</b>{inModal ? ` · ${t('dialog')}` : ''} · {t('click a number to suggest a change')} · {t('{n} components', { n: items.length })}</span>
        <button type="button" className="suggest-bar-btn" onClick={scan} title={t('Renumber (after opening a dialog or changing tab)')}>{t('Renumber')}</button>
        <button type="button" className="suggest-bar-btn suggest-bar-done" onClick={onExit}>{t('Done')}</button>
      </div>
      {hoverRect ? <div className="suggest-outline" style={{ left: hoverRect.left - 3, top: hoverRect.top - 3, width: hoverRect.width + 6, height: hoverRect.height + 6 }} /> : null}
      {items.map(it => {
        if (!it.el.isConnected) return null;
        const r = it.el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
        return (
          <button type="button" key={it.code} className="suggest-num" aria-pressed={picked?.code === it.code} title={`${it.code} · ${it.kind}`}
            aria-label={t('Component {code}, {kind}', { code: it.code, kind: it.kind })} style={{ left: Math.max(2, r.left - 8), top: Math.max(2, r.top - 8) }}
            onMouseEnter={() => setHover(it)} onMouseLeave={() => setHover(h => (h === it ? null : h))} onFocus={() => setHover(it)} onClick={() => setPicked(it)}>
            {it.explicit ? it.code.split('.').pop() : it.n}
          </button>
        );
      })}
      {picked ? <SuggestPanel key={picked.code} item={picked} pageCode={pageCode} onClose={() => setPicked(null)} onSubmit={onSubmit} loadOpen={loadOpen} triageHint={triageHint} /> : null}
    </div>
  );
}

const KIND_LABEL: [SuggestedChange['kind'], string][] = [['change', 'Change'], ['bug', 'Bug'], ['new', 'New feature']];   // English keys of the catalogue

function SuggestPanel({ item, pageCode, onClose, onSubmit, loadOpen, triageHint }: { item: Item; pageCode: string; onClose: () => void; triageHint: string;
  onSubmit: (c: SuggestedChange) => Promise<void>; loadOpen: (pageCode: string) => Promise<OpenRequest[]> }) {
  const t = useT();
  const [kind, setKind] = useState<SuggestedChange['kind']>('change');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState<OpenRequest[] | null>(null);
  const shown = textOf(item.el);

  useEffect(() => { let live = true; loadOpen(pageCode).then(o => live && setOpen(o), () => live && setOpen([])); return () => { live = false; }; }, [pageCode, loadOpen]);

  const submit = async () => {
    if (!text.trim()) { setError(t('Describe the change first.')); return; }
    setBusy(true); setError(null);
    try {
      await onSubmit({ page_code: pageCode, component_code: item.code, component_kind: item.kind, component_text: shown, dom_path: domPath(item.el),
        route: window.location.hash || window.location.pathname, kind, request: text.trim() });
      setOpen(o => [{ id: `sent-${Date.now()}`, component_code: item.code, request: text.trim(), status: 'new' }, ...(o ?? [])]);
      setSent(true); setText('');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const same = (open ?? []).filter(o => o.component_code === item.code).length;
  return (
    <div className="suggest-panel" role="dialog" aria-label={t('Suggest a change on {code}', { code: item.code })}>
      <div className="suggest-panel-head">
        <div><strong className="t-mono">{item.code}</strong><small>{item.kind}{shown ? ` · “${shown.slice(0, 70)}${shown.length > 70 ? '…' : ''}”` : ''}</small></div>
        <button type="button" className="suggest-bar-btn" onClick={onClose} aria-label={t('Close')}>×</button>
      </div>
      <div className="row" role="radiogroup" aria-label={t('Type of request')}>
        {KIND_LABEL.map(([k, l]) => <button type="button" key={k} role="radio" aria-checked={kind === k} className="suggest-kind" onClick={() => setKind(k)}>{t(l)}</button>)}
      </div>
      <Textarea aria-label={t('What should change')} value={text} onChange={e => setText(e.target.value)} rows={4} autoFocus disabled={busy}
        placeholder={t('What should change here? For example: add a column with the due date, sort by site, rename this button…')} />
      <small className="t-muted">{t('Describe the screen, not patients: no personal or clinical data in the request.')}</small>
      {error ? <span><StatusPill tone="bad">{t('Not sent')}</StatusPill> {error}</span> : null}
      {sent ? <small role="status">{t('Sent — it is in {where} with code {code}. Pick another number or press Done.', { where: triageHint, code: item.code })}</small> : null}
      <div className="modal-actions">
        <Button onClick={onClose}>{t('Close')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => { void submit(); }}>{busy ? t('Sending…') : t('Send suggestion')}</Button>
      </div>
      {open?.length ? (
        <div className="suggest-open">
          <span className="suggest-open-title">{t('Open on {page}: {n}', { page: pageCode, n: open.length })}{same ? ` · ${t('{n} on this component', { n: same })}` : ''}</span>
          {open.slice(0, 6).map(o => <div key={o.id} data-same={o.component_code === item.code ? 'true' : undefined}>
            <span className="t-mono">{(o.component_code ?? '').split('.').pop()}</span> {o.request.slice(0, 90)}{o.request.length > 90 ? '…' : ''}</div>)}
        </div>
      ) : null}
    </div>
  );
}
