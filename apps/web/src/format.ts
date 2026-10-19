import { formatDate, formatDateTime, type Tone } from '@trialops/shell';

/** Date in the locale of the page (NFR-07). */
export const fmtDate = (v?: string | null) => formatDate(v);
/** Date and time in the locale of the page, with the time zone shown (rule 11: the server stores UTC). */
export const fmtDateTime = (v?: string | null) => formatDateTime(v);
export const human = (s?: string | null) => (s ?? '—').replace(/_/g, ' ');
export const short = (id?: string | null) => id ? id.slice(0, 8) : '—';

const TONES: Record<string, Tone> = {
  active: 'ok', approved: 'ok', completed: 'ok', activated: 'ok', success: 'ok', final_met: 'ok', accepted: 'ok', executed: 'ok', effective: 'ok',
  draft: 'neutral', candidate: 'neutral', created: 'neutral', assigned: 'info', in_progress: 'info', pending_approval: 'warn', in_review: 'warn',
  waiting_review: 'warn', interim_met: 'neutral', edited: 'warn', qualified: 'info', on_hold: 'warn', suspended: 'warn',
  off_target: 'bad', rejected: 'bad', blocked: 'bad', error: 'bad', validation_failed: 'bad', uninstalled: 'neutral', superseded: 'neutral',
  closed: 'neutral', graduated: 'ok', void: 'neutral', no_data: 'neutral', timeout: 'bad', expired: 'bad', cancelled: 'neutral',
};
export const tone = (status?: string | null): Tone => TONES[status ?? ''] ?? 'neutral';
export const METRIC_LABEL: Record<string, string> = { final_met: 'Final target met', interim_met: 'Interim target met', off_target: 'Off target', no_data: 'No data yet' };
