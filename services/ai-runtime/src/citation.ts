// Mandatory source citation (AI-04, CMP-07 explainability): an extraction or classification output is accepted only if
// every item the task type declares is supported by a source entry, and every quote is found verbatim (whitespace
// normalised, case sensitive) in the input document it names. The runtime refuses the output otherwise
// (outcome validation_failed); the credibility harness uses the same function to measure source fidelity.
import type { CitationPolicy } from './registry.ts';

/** Collapses runs of whitespace (line breaks, tabs, non-breaking spaces) to one space; nothing else changes. */
export const normaliseText = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const normaliseId = (s: unknown): string => normaliseText(String(s ?? '')).toLowerCase();

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export interface QuoteCheck { section: string; item_id: string; ref: string; verbatim: boolean; problem?: string }
export interface CitationReport {
  items: { section: string; item_id: string; supported: boolean }[];   // declared items and whether a verbatim source supports them
  quotes: QuoteCheck[];                                                // every source entry of the output
  unsupported: { section: string; item_id: string }[];                 // declared items without any source entry
  errors: string[];
}

export function checkCitations(policy: CitationPolicy, input: Record<string, unknown>, output: unknown): CitationReport {
  const docs = new Map<string, string>();
  const rawDocs = getPath(input, policy.documents);
  const citable = (Array.isArray(rawDocs) ? [...rawDocs] : []) as { ref?: unknown; text?: unknown }[];
  // The Master Protocol is citable only when the input carries its text and ref (inherited content); a bare USDM object
  // without text gives nothing to quote, so a citation of it is refused like any unknown document.
  const master = policy.master_document ? getPath(input, policy.master_document) as { ref?: unknown; text?: unknown } | undefined : undefined;
  if (master && typeof master === 'object') citable.push(master);
  for (const d of citable) {
    if (d && typeof d.ref === 'string' && d.ref.trim() && typeof d.text === 'string' && !docs.has(d.ref)) docs.set(d.ref, normaliseText(d.text));
  }
  const rawSources = getPath(output, policy.sources);
  const sources = (Array.isArray(rawSources) ? rawSources : []) as { section?: unknown; item_id?: unknown; ref?: unknown; quote?: unknown }[];
  const errors: string[] = [];
  const quotes: QuoteCheck[] = sources.map(s => {
    const base = { section: String(s.section ?? ''), item_id: String(s.item_id ?? ''), ref: String(s.ref ?? '') };
    const quote = typeof s.quote === 'string' ? normaliseText(s.quote) : '';
    const doc = docs.get(base.ref);
    let problem: string | undefined;
    if (doc === undefined) problem = `cites ${base.ref || 'no document'}, which is not an input document`;
    else if (quote.length < policy.min_quote_chars) problem = `quote shorter than ${policy.min_quote_chars} characters`;
    else if (!doc.includes(quote)) problem = `quote not found verbatim in ${base.ref}`;
    if (problem) errors.push(`${base.section} ${base.item_id}: ${problem}`);
    return { ...base, verbatim: !problem, ...(problem ? { problem } : {}) };
  });
  const items: CitationReport['items'] = [];
  const unsupported: CitationReport['unsupported'] = [];
  for (const spec of policy.items) {
    const list = getPath(output, spec.path);
    for (const item of Array.isArray(list) ? list as Record<string, unknown>[] : []) {
      const id = String(item?.[spec.key] ?? '');
      const cited = quotes.filter(q => normaliseId(q.item_id) === normaliseId(id));
      if (cited.length === 0) {
        unsupported.push({ section: spec.section, item_id: id });
        errors.push(`${spec.section} ${id || '(no id)'}: no source`);
      }
      items.push({ section: spec.section, item_id: id, supported: cited.some(q => q.verbatim) });
    }
  }
  return { items, quotes, unsupported, errors };
}

/** One-line error for the caller and the ledger, bounded in length. */
export function citationError(r: CitationReport): string {
  const head = r.errors.slice(0, 8).join('; ');
  return `citation check failed (AI-04): ${head}${r.errors.length > 8 ? `; and ${r.errors.length - 8} more` : ''}`;
}
