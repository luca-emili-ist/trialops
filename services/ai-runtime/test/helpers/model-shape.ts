// Test helper (prompt v2, CR-AI-0001): turns an appendix in the platform shape (legacy `sources` list and
// `consistency_checks` list) into what the model answers with prompt v2 (a `source` inside each cited item, a fixed
// `consistency` object). Inverse of the task type's normalise.
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
  // draft v2.3: legacy consistency_checks → topic-tagged checks (the two required topics added if missing)
  const o = out as Record<string, any>;
  if (Array.isArray(o.consistency_checks) && !o.consistency_checks.some((c: any) => 'topic' in c)) {
    const topic = (c: { check: string }) => /population/i.test(c.check) ? 'shared_population' : /schedule|visit/i.test(c.check) ? 'visit_schedule' : 'other';
    const list = o.consistency_checks.map((c: any) => ({ topic: topic(c), ...c }));
    for (const t of ['shared_population', 'visit_schedule']) {
      if (!list.some((c: any) => c.topic === t)) list.push({ topic: t, check: `Required topic ${t}`, result: 'pass', detail: 'Not assessed in this test answer (helper default for the required topic).' });
    }
    o.consistency_checks = list;
  }
  return out;
}
