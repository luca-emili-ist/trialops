// Error contract: { error: { code, message } }. Database guards (audit, RLS, state machines, signatures) surface
// as 4xx with their own message, so a refusal by the database is visible to the caller and never swallowed.
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface PgError { code?: string; message?: string }

export function toHttp(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  // typed errors of other TrialOps packages (e.g. AiRequestError) carry their own status and code
  const typed = e as { status?: unknown; code?: unknown; message?: string };
  if (typeof typed?.status === 'number' && typed.status < 500 && typeof typed.code === 'string') {
    return new HttpError(typed.status, typed.code, typed.message ?? typed.code);
  }
  const pg = e as PgError;
  switch (pg?.code) {
    case '42501': return new HttpError(403, 'forbidden', pg.message ?? 'forbidden');           // privilege / RLS
    case '23514': return new HttpError(422, 'rule_violation', pg.message ?? 'rule violation');  // check / GxP rule
    case '23505': return new HttpError(409, 'conflict', pg.message ?? 'conflict');
    case '23503': return new HttpError(422, 'invalid_reference', pg.message ?? 'invalid reference');
    case '23502': return new HttpError(422, 'missing_field', pg.message ?? 'missing field');
    case '22P02': return new HttpError(400, 'invalid_input', pg.message ?? 'invalid input');
    case 'P0001': return new HttpError(422, 'rule_violation', pg.message ?? 'rule violation');
    default: return new HttpError(500, 'internal', 'internal error');
  }
}
