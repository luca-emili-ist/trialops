// AI-10 continuous monitoring per task type and platform. Metrics come from the AI ledger (core.ai_request: outcomes,
// validation errors, output size) and from the human outcome of the proposals (review_decision of the ledger row; for
// the onboarding planner, what people did with the tasks it generated). The rules of the registry (= credibility plan
// §7) decide when a task type falls back to suggestion-only; the state lives in core.ai_task_type_state (0023).
// Metrics are computed since the last change of state, so a task type put back to normal starts from a clean window.
import type { TaskTypeDef } from '@trialops/ai-runtime';
import type { Db, Row } from '../db.ts';

export type Mode = 'normal' | 'suggestion_only';

export async function taskTypeMode(db: Db, platformId: string, taskType: string): Promise<Mode> {
  const r = (await db.query('select mode from core.ai_task_type_state where platform_id = $1 and task_type = $2', [platformId, taskType])).rows[0];
  return (r?.mode as Mode | undefined) ?? 'normal';
}

const rate = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 10000) / 10000);
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface RuleResult { metric: string; max: number; min_sample: number; value: number | null; sample: number; breach: boolean }

export async function monitorTaskType(db: Db, platformId: string, def: TaskTypeDef): Promise<Row> {
  const state = (await db.query(`select mode, reason, source, changed_by, changed_at from core.ai_task_type_state
    where platform_id = $1 and task_type = $2`, [platformId, def.task_type])).rows[0] ?? null;
  const since: string | null = state?.changed_at ? new Date(state.changed_at).toISOString() : null;
  const m = def.monitoring;
  const calls = (await db.query(`select outcome, validation_error, output_tokens, review_decision from core.ai_request
    where platform_id = $1 and task_type = $2 and ($3::timestamptz is null or created_at > $3) order by created_at desc limit 5000`,
    [platformId, def.task_type, since])).rows;
  const count = (f: (r: Row) => boolean) => calls.filter(f).length;
  const outcomes = Object.fromEntries(['success', 'validation_failed', 'error', 'timeout', 'blocked'].map(o => [o, count(r => r.outcome === o)]));
  const reviews = calls.filter(r => r.review_decision).slice(0, m.window);
  const rv = (d: string) => reviews.filter(r => r.review_decision === d).length;

  // People's verdict on generated work: tasks created from this task type's output, cancelled or moved to another assignee.
  const generated = (await db.query(`select t.state, t.assignee_kind, t.assignee, t.inputs->>'assignee_role' original
      from core.task t join core.ai_request r on r.id::text = t.inputs->>'ai_request_id'
     where t.platform_id = $1 and r.task_type = $2 and ($3::timestamptz is null or t.created_at > $3)
     order by t.created_at desc limit $4`, [platformId, def.task_type, since, m.window])).rows;
  const cancelled = generated.filter(t => t.state === 'cancelled').length;
  const reassigned = generated.filter(t => t.state !== 'cancelled' && t.original
    && (t.assignee_kind !== 'role' || t.assignee !== t.original)).length;

  const metrics = {
    calls: calls.length, outcomes,
    validation_failure_rate: rate(outcomes.validation_failed!, calls.length),
    unsupported_items: count(r => typeof r.validation_error === 'string' && r.validation_error.startsWith('citation:')),
    reviewed: reviews.length, accepted: rv('accepted'), edited: rv('edited'), rejected: rv('rejected'),
    acceptance_rate: rate(rv('accepted'), reviews.length), edit_rate: rate(rv('edited'), reviews.length),
    rejection_rate: rate(rv('rejected'), reviews.length),
    generated_tasks: generated.length, generated_tasks_cancelled: cancelled, generated_tasks_reassigned: reassigned,
    generated_tasks_cancelled_or_reassigned_rate: rate(cancelled + reassigned, generated.length),
  };
  const samples: Record<string, number> = {
    edit_rate: reviews.length, rejection_rate: reviews.length, validation_failure_rate: calls.length, unsupported_items: calls.length,
    generated_tasks_cancelled_or_reassigned_rate: generated.length,
  };

  // Drift: the last N calls against the N before (output size of the successful ones, share of non-success outcomes).
  const w = m.drift.window;
  const last = calls.slice(0, w), prev = calls.slice(w, 2 * w);
  const tokens = (rs: Row[]) => mean(rs.filter(r => r.outcome === 'success' && r.output_tokens !== null).map(r => Number(r.output_tokens)));
  const failures = (rs: Row[]) => (rs.length ? rs.filter(r => r.outcome !== 'success').length / rs.length : null);
  const [tl, tp, fl, fp] = [tokens(last), tokens(prev), failures(last), failures(prev)];
  const tokChange = tl !== null && tp ? Math.round(((tl - tp) / tp) * 10000) / 10000 : null;
  const failChange = fl !== null && fp !== null ? Math.round((fl - fp) * 10000) / 10000 : null;
  const drift = {
    window: w, last_calls: last.length, previous_calls: prev.length,
    output_tokens_last: tl, output_tokens_previous: tp, output_tokens_change: tokChange,
    failure_rate_last: fl, failure_rate_previous: fp, failure_rate_change: failChange,
    signal: prev.length < w ? 'insufficient_data'
      : (tokChange !== null && Math.abs(tokChange) > m.drift.max_output_tokens_change) || (failChange !== null && Math.abs(failChange) > m.drift.max_failure_rate_change)
        ? 'drift' : 'stable',
  };

  const rules: RuleResult[] = m.rules.map(r => {
    const value = (metrics as Record<string, unknown>)[r.metric] as number | null;
    const sample = samples[r.metric] ?? 0;
    return { metric: r.metric, max: r.max, min_sample: r.min_sample, value, sample, breach: value !== null && sample >= r.min_sample && value > r.max };
  });
  return {
    task_type: def.task_type, gxp: def.gxp, risk: def.risk, model: def.model, prompt_version: def.prompt_version,
    mode: (state?.mode as Mode | undefined) ?? 'normal', state, since, window: m.window, metrics, drift, rules,
    breach: rules.some(r => r.breach),
  };
}

/** Human-readable reason of a fall back, recorded with the state change. */
export function breachReason(r: Row): string {
  return 'AI-10 threshold crossed: ' + (r.rules as RuleResult[]).filter(x => x.breach)
    .map(x => `${x.metric} ${x.value} > ${x.max} (n=${x.sample})`).join('; ');
}
