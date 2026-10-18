// Test helper (prompt v2, CR-AI-0001): turns an appendix in the platform shape (legacy `sources` list) into what the
// model answers with prompt v2 (a `source` inside each cited item, no `sources` list). Inverse of perItemSourcesToList.
import type { CitationPolicy } from '../../src/registry.ts';

export function toModelShape(policy: CitationPolicy, legacy: unknown): Record<string, unknown> {
  const { sources = [], ...out } = structuredClone(legacy) as { sources?: { section: string; item_id: string; ref: string; quote: string }[] };
  for (const spec of policy.items) {
    const parts = spec.path.split('.'); const leaf = parts.pop()!;
    const parent = parts.reduce<any>((o, k) => (o && typeof o === 'object' ? o[k] : undefined), out);
    if (!Array.isArray(parent?.[leaf])) continue;
    for (const item of parent[leaf]) {
      const s = sources.find(x => x.section === spec.section && x.item_id === String(item[spec.key]));
      if (s) item.source = { ref: s.ref, quote: s.quote };
    }
  }
  return out;
}
