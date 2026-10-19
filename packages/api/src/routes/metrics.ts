// SURPASS TA3 metrics (M11-01 catalogue, M11-02 values vs targets with drill-down). Every number comes from records;
// nothing is typed in. Facts and targets are kept apart (spec principle 3).
import { route, uuid } from '../route.ts';
import type { Db, Row } from '../db.ts';
import { HttpError } from '../errors.ts';

export type MetricStatus = 'final_met' | 'interim_met' | 'off_target' | 'no_data';

export function evaluate(def: Row, value: number | null): MetricStatus {
  if (value === null || value === undefined) return 'no_data';
  const lower = def.direction !== 'higher_is_better';
  const meets = (t: number | null) => t !== null && (lower ? value <= Number(t) : value >= Number(t));
  return meets(def.final_target) ? 'final_met' : meets(def.interim_target) ? 'interim_met' : 'off_target';
}

interface Source { kind: 'record' | 'event'; table: string; id: string; label: string; at: string | null }
interface Value { arm_id: string | null; arm_code: string | null; value: number | null; status: MetricStatus; sources: Source[] }

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const rec = (table: string, id: string, label: string, at: unknown): Source => ({ kind: 'record', table, id, label, at: at ? new Date(at as string).toISOString() : null });

/** Per-arm onboarding metrics from core.v_arm_onboarding plus the records each value is computed from. */
async function armMetric(db: Db, platformId: string, code: string): Promise<Value[]> {
  const rows = (await db.query('select * from core.v_arm_onboarding where platform_id = $1 order by arm_created_at', [platformId])).rows;
  const out: Value[] = [];
  for (const r of rows) {
    const sources: Source[] = [];
    let value: number | null = null;
    if (code === 'TA3-CONTRACT-ARM') {
      value = num(r.contract_days);
      sources.push(rec('arm', r.arm_id, `Arm ${r.code} created`, r.arm_created_at));
      const c = (await db.query(`select id, executed_at from core.contract where arm_id = $1 and kind = 'arm_addendum' and status <> 'void'
        order by executed_at limit 1`, [r.arm_id])).rows[0];
      if (c) sources.push(rec('contract', c.id, 'Arm addendum executed', c.executed_at));
    } else if (code === 'TA3-IRB-ARM') {
      value = num(r.irb_days);
      const s = (await db.query(`select id, submitted_at, outcome_at from core.submission where arm_id = $1 and kind = 'irb_initial'
        and outcome like 'approved%' order by outcome_at limit 1`, [r.arm_id])).rows[0];
      if (s) sources.push(rec('submission', s.id, 'IRB submitted', s.submitted_at), rec('submission', s.id, 'IRB approved', s.outcome_at));
    } else if (code === 'TA3-MP-FSD-ARM') {
      value = num(r.may_proceed_to_fsd_days);
      const s = (await db.query(`select id, outcome_at from core.submission where arm_id = $1 and kind in ('ind_amendment','ind_initial')
        and outcome = 'may_proceed' order by outcome_at limit 1`, [r.arm_id])).rows[0];
      if (s) sources.push(rec('submission', s.id, 'FDA may proceed', s.outcome_at));
      if (r.first_randomized_at) sources.push({ kind: 'record', table: 'subject_status_history', id: r.arm_id, label: 'First subject randomized in arm',
        at: new Date(r.first_randomized_at).toISOString() });
    }
    out.push({ arm_id: r.arm_id, arm_code: r.code, value, status: 'no_data', sources });
  }
  return out;
}

async function platformMetric(db: Db, platformId: string, code: string): Promise<Value[]> {
  if (code === 'TA3-IND-FSD') {
    const r = (await db.query(`select s.id, s.submitted_at,
        (select min(h.changed_at) from core.subject_status_history h where h.platform_id = $1 and h.to_status = 'randomized') fsd
      from core.submission s where s.platform_id = $1 and s.kind = 'ind_initial' and s.status <> 'void' order by s.submitted_at limit 1`, [platformId])).rows[0];
    if (!r?.fsd) return [{ arm_id: null, arm_code: null, value: null, status: 'no_data', sources: [] }];
    const days = Math.round((Date.parse(r.fsd) - Date.parse(r.submitted_at)) / 864e5 * 10) / 10;
    return [{ arm_id: null, arm_code: null, value: days, status: 'no_data',
      sources: [rec('submission', r.id, 'IND submitted', r.submitted_at), { kind: 'record', table: 'subject_status_history', id: platformId,
        label: 'First subject randomized', at: new Date(r.fsd).toISOString() }] }];
  }
  if (code === 'TA3-DATA-COLLECT') {
    // EDC-12: visit date -> data available (visit completed, event visit.completed), mean over completed visits. Platform level
    // only: a per-arm value would need the allocation (rule 5). The view keeps the reader's perimeter.
    const visits = (await db.query(`select subject_visit_id, visit_code, visit_date::text visit_date, completed_at, days_to_data from core.v_visit_data_collection
      where platform_id = $1 order by completed_at desc`, [platformId])).rows;
    if (!visits.length) return [{ arm_id: null, arm_code: null, value: null, status: 'no_data', sources: [] }];
    const mean = Math.round(visits.reduce((a, v) => a + Number(v.days_to_data), 0) / visits.length * 10) / 10;
    return [{ arm_id: null, arm_code: null, value: mean, status: 'no_data',
      sources: visits.slice(0, 50).map(v => rec('subject_visit', v.subject_visit_id, `Visit ${v.visit_code} of ${v.visit_date} completed: ${Number(v.days_to_data)} days`, v.completed_at)) }];
  }
  if (code === 'TA3-HUMAN-HOURS') {
    // The ratio needs a historical FTE baseline that is not loaded yet: report the measured hours as a source, value null.
    const h = (await db.query(`select coalesce(sum(hours),0)::float hours, count(*)::int n from core.time_entry where platform_id = $1 and status <> 'void'`,
      [platformId])).rows[0];
    return [{ arm_id: null, arm_code: null, value: null, status: 'no_data',
      sources: [{ kind: 'record', table: 'time_entry', id: platformId, label: `${h.hours} hours recorded in ${h.n} entries (baseline missing)`, at: null }] }];
  }
  return [{ arm_id: null, arm_code: null, value: null, status: 'no_data', sources: [] }];
}

const PER_ARM = new Set(['TA3-CONTRACT-ARM', 'TA3-IRB-ARM', 'TA3-MP-FSD-ARM']);

export async function metricValues(db: Db, platformId: string, def: Row): Promise<Value[]> {
  const values = PER_ARM.has(def.code) ? await armMetric(db, platformId, def.code) : await platformMetric(db, platformId, def.code);
  return values.map(v => ({ ...v, status: evaluate(def, v.value) }));
}

/** Events linked to the source records (drill-down to the event, M11-02). */
async function eventsFor(db: Db, sources: Source[]): Promise<Source[]> {
  const subjects = sources.filter(s => s.kind === 'record' && ['arm', 'contract', 'submission', 'subject_visit'].includes(s.table)).map(s => {
    const prefix = s.table === 'arm' ? 'arm' : s.table;
    return `${prefix}/${s.id}`;
  });
  if (!subjects.length) return [];
  return (await db.query('select id, type, subject, time from core.event_outbox where subject = any($1) order by time', [subjects])).rows
    .map(e => ({ kind: 'event' as const, table: 'event_outbox', id: e.id, label: `${e.type} (${e.subject})`, at: new Date(e.time).toISOString() }));
}

export const metricRoutes = [
  route({ method: 'get', path: '/v1/metrics/definitions', summary: 'SURPASS metric catalogue', tag: 'metrics', reqs: ['M11-01'],
    handler: async ({ db }) => ({ items: (await db.query('select * from core.metric_definition order by code')).rows }) }),

  route({ method: 'get', path: '/v1/platforms/:id/metrics', summary: 'SURPASS metrics vs interim and final targets, per platform and arm',
    tag: 'metrics', reqs: ['M11-02', 'IAM-03'],
    handler: async ({ db, params }) => {
      const p = (await db.query('select id from core.platform where id = $1', [params.id])).rows[0];
      if (!p) return undefined;
      const defs = (await db.query('select * from core.metric_definition order by code')).rows;
      const items = [];
      for (const d of defs) {
        const values = (await metricValues(db, p.id, d)).map(({ sources: _s, ...v }) => v);
        // Platform headline for per-arm metrics: the most recent arm, the one that shows the platform learning effect.
        const headline = [...values].reverse().find(v => v.value !== null) ?? values[values.length - 1] ?? null;
        items.push({ code: d.code, name: d.name, unit: d.unit, direction: d.direction, interim_target: num(d.interim_target),
          final_target: num(d.final_target), per_arm: PER_ARM.has(d.code), headline, values });
      }
      return { platform_id: p.id, computed_at: new Date().toISOString(), items };
    } }),

  route({ method: 'get', path: '/v1/platforms/:id/metrics/:code', summary: 'Drill-down of one metric to source records and events',
    tag: 'metrics', reqs: ['M11-02'], query: { arm_id: uuid },
    handler: async ({ db, params, query }) => {
      const d = (await db.query('select * from core.metric_definition where code = $1', [params.code])).rows[0];
      if (!d) throw new HttpError(404, 'unknown_metric', `unknown metric ${params.code}`);
      const values = (await metricValues(db, params.id!, d)).filter(v => !query.arm_id || v.arm_id === query.arm_id);
      const withEvents = [];
      for (const v of values) withEvents.push({ ...v, events: await eventsFor(db, v.sources) });
      return { definition: d, values: withEvents };
    } }),
];
