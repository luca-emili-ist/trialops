-- TrialOps · 0023 AI monitoring per task type, fall back to suggestion-only
-- Req: AI-10 (continuous monitoring per task type: acceptance/edit/rejection rate of the reviewed proposals, validation
--      failures, drift; below threshold the task type falls back to suggestion-only), AI-04 (the reason of a refused
--      output is kept in the ledger: schema or citation), AI-06 (ledger rows stay immutable facts).
--   * core.ai_request.validation_error: why the runtime refused an output ('schema: ...' or 'citation: ...'). Written
--     once by the runtime with the row; the immutability trigger of 0012 covers it like every other column.
--   * core.ai_task_type_state: the mode of a task type on a platform (normal | suggestion_only), with the reason, the
--     metrics snapshot that justified it, who changed it and when (server UTC, rule 11). No row = normal.
--     Written only through core.ai_task_type_set_mode() by a platform admin (a person); the evaluation may only send a
--     task type to suggestion-only, the way back to normal is an explicit decision with a reason. Every change is audited
--     (attach_std, gxp: an update needs a change reason, the function sets it from p_reason); no delete.
-- Idempotent: it can be run again.

-- ===== ledger: reason of a refused output =====
alter table core.ai_request add column if not exists validation_error text;
alter table core.ai_request drop constraint if exists ai_request_validation_error_check;
alter table core.ai_request add constraint ai_request_validation_error_check
  check (validation_error is null or (outcome = 'validation_failed' and length(validation_error) <= 2000));
create index if not exists ai_request_monitoring_idx on core.ai_request (platform_id, task_type, created_at desc);

-- ===== task type state =====
create table if not exists core.ai_task_type_state (
  id           uuid primary key default gen_random_uuid(),
  platform_id  uuid not null references core.platform(id),
  task_type    text not null check (task_type ~ '^[a-z0-9_.-]{1,100}$'),
  mode         text not null check (mode in ('normal', 'suggestion_only')),
  reason       text not null check (length(btrim(reason)) > 0 and length(reason) <= 2000),
  source       text not null check (source in ('evaluation', 'manual')),
  metrics      jsonb not null default '{}',
  changed_by   text not null default core.current_sub(),
  changed_at   timestamptz not null default clock_timestamp(),
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  row_version  int not null default 1,
  unique (platform_id, task_type)
);
comment on table core.ai_task_type_state is 'Mode of an AI task type per platform (AI-10): normal or suggestion_only; changed only by core.ai_task_type_set_mode, audited';

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ai_task_type_state'::regclass and tgname = 'audit') then
    perform core.attach_std('core.ai_task_type_state', 'gxp');
  end if;
end $$;

-- The identity of a state row never changes; who and when are set by the database, not by the caller.
create or replace function core.ai_task_type_state_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.platform_id is distinct from old.platform_id or new.task_type is distinct from old.task_type
                           or new.created_at is distinct from old.created_at) then
    raise exception 'platform and task type of an AI task type state cannot change (AI-10)' using errcode = 'insufficient_privilege';
  end if;
  new.changed_by := core.current_sub();
  new.changed_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists guard on core.ai_task_type_state;
create trigger guard before insert or update on core.ai_task_type_state for each row execute function core.ai_task_type_state_guard();

create or replace function core.ai_task_type_set_mode(p_platform uuid, p_task_type text, p_mode text, p_reason text,
  p_metrics jsonb default '{}', p_source text default 'manual') returns core.ai_task_type_state
language plpgsql security definer set search_path = core, public as $$
declare v_old core.ai_task_type_state; v_new core.ai_task_type_state; v_exists boolean;
begin
  if core.current_actor_type() <> 'user' or not (coalesce(core.jwt()->'roles', '[]'::jsonb) ? 'platform_admin') then
    raise exception 'only a platform admin (a person) changes the mode of an AI task type (AI-10)' using errcode = 'insufficient_privilege';
  end if;
  if core.claim_uuid_list('platform_ids') is not null and not p_platform = any(core.claim_uuid_list('platform_ids')) then
    raise exception 'platform outside the token (AI-10)' using errcode = 'insufficient_privilege';
  end if;
  if p_mode is null or p_mode not in ('normal', 'suggestion_only') then
    raise exception 'mode must be normal or suggestion_only (AI-10)' using errcode = 'check_violation';
  end if;
  if p_source is null or p_source not in ('evaluation', 'manual') then
    raise exception 'source must be evaluation or manual (AI-10)' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'changing the mode of an AI task type needs a reason (DM-03)' using errcode = 'check_violation';
  end if;
  if p_source = 'evaluation' and p_mode <> 'suggestion_only' then
    raise exception 'the evaluation only falls back to suggestion-only; back to normal is an explicit decision (AI-10)' using errcode = 'check_violation';
  end if;
  select * into v_old from core.ai_task_type_state where platform_id = p_platform and task_type = p_task_type for update;
  v_exists := found;
  if v_exists and v_old.mode = p_mode then return v_old; end if;         -- already in that mode: nothing to record
  perform set_config('trialops.change_reason', btrim(p_reason), true);
  if not v_exists then
    insert into core.ai_task_type_state (platform_id, task_type, mode, reason, source, metrics)
    values (p_platform, p_task_type, p_mode, btrim(p_reason), p_source, coalesce(p_metrics, '{}'))
    returning * into v_new;
  else
    update core.ai_task_type_state set mode = p_mode, reason = btrim(p_reason), source = p_source, metrics = coalesce(p_metrics, '{}')
     where id = v_old.id returning * into v_new;
  end if;
  return v_new;
end $$;

alter table core.ai_task_type_state enable row level security;
drop policy if exists read on core.ai_task_type_state;
create policy read on core.ai_task_type_state for select using (core.can_see_platform(platform_id));
revoke all on core.ai_task_type_state from public, anon, authenticated, app_service;
grant select on core.ai_task_type_state to authenticated;
revoke execute on function core.ai_task_type_set_mode(uuid, text, text, text, jsonb, text) from public;
grant execute on function core.ai_task_type_set_mode(uuid, text, text, text, jsonb, text) to authenticated;
