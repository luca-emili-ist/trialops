import type { Tone } from '@trialops/shell';

export const fmtDate = (v?: string | null) => v ? new Date(v).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
export const fmtDateTime = (v?: string | null) => v ? new Date(v).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const human = (s?: string | null) => (s ?? '—').replace(/_/g, ' ');
export const short = (id?: string | null) => id ? id.slice(0, 8) : '—';

const TONES: Record<string, Tone> = {
  active: 'ok', approved: 'ok', completed: 'ok', activated: 'ok', success: 'ok', final_met: 'ok', accepted: 'ok', executed: 'ok', effective: 'ok',
  draft: 'neutral', candidate: 'neutral', created: 'neutral', assigned: 'info', in_progress: 'info', pending_approval: 'warn', in_review: 'warn',
  waiting_review: 'warn', interim_met: 'warn', edited: 'warn', qualified: 'info', on_hold: 'warn', suspended: 'warn',
  off_target: 'bad', rejected: 'bad', blocked: 'bad', error: 'bad', validation_failed: 'bad', uninstalled: 'neutral', superseded: 'neutral',
  closed: 'neutral', graduated: 'ok', void: 'neutral', no_data: 'neutral', timeout: 'bad', expired: 'bad', cancelled: 'neutral',
};
export const tone = (status?: string | null): Tone => TONES[status ?? ''] ?? 'neutral';
export const METRIC_LABEL: Record<string, string> = { final_met: 'Final target met', interim_met: 'Interim target met', off_target: 'Off target', no_data: 'No data yet' };
