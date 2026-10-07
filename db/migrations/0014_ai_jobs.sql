-- TrialOps · 0014 AI jobs: asynchronous execution of AI tasks and agent runs
-- Req: AI-01 (every call still goes through the AI runtime), AI-06 (the ledger stays one immutable fact per model call:
--      the job only points to it), AI-09 (max_execution_time per job: an overrun stops the job), IAM-02/IAM-03 (RLS)
--
-- Why: model calls of the agents can last minutes, longer than a synchronous HTTP function may run. The request is
-- recorded first as a job (status queued), a worker runs it (status running) and records the outcome (completed/failed);
-- the client polls the job. core.ai_request is NOT changed: its rows are immutable facts written by the runtime (0012).

create table core.ai_job (
  id              uuid primary key default gen_random_uuid(),
  platform_id     uuid references core.platform(id),
  arm_id          uuid references core.arm(id),
  task_id         uuid references core.task(id),
  kind            text not null check (kind in ('ai_task','agent_run')),
  request         jsonb not null,
  status          text not null default 'queued' check (status in ('queued','running','completed','failed')),
  result          jsonb,
  error           text,
  ai_request_id   uuid references core.ai_request(id),
  requested_by    text not null default core.current_sub(),
  max_execution_s int not null default 840 check (max_execution_s between 1 and 900),   -- 14 min, under the 15 min worker limit
  deadline_at     timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  row_version     int not null default 1,
  check (status <> 'completed' or result is not null),
  check (status <> 'failed' or error is not null)
);
select core.attach_std('core.ai_job', 'operational');
create index on core.ai_job (platform_id, created_at desc);
-- one active run per agent task: a second click returns the job already queued or running
create unique index ai_job_one_active_run on core.ai_job (task_id) where kind = 'agent_run' and status in ('queued','running');

-- State machine: queued -> running -> completed | failed, queued -> failed. Terminal jobs are immutable; the request,
-- its owner and its perimeter never change after insert.
create or replace function core.ai_job_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'queued' then raise exception 'an AI job starts queued (AI-09)' using errcode = 'check_violation'; end if;
    new.requested_by := core.current_sub();
    new.started_at := null; new.finished_at := null; new.result := null; new.error := null; new.ai_request_id := null;
    new.deadline_at := new.created_at + make_interval(secs => new.max_execution_s);
    return new;
  end if;
  if (to_jsonb(new) - array['status','result','error','ai_request_id','started_at','finished_at','updated_at','row_version'])
     is distinct from (to_jsonb(old) - array['status','result','error','ai_request_id','started_at','finished_at','updated_at','row_version']) then
    raise exception 'only the status and the outcome of an AI job can change' using errcode = 'insufficient_privilege';
  end if;
  if old.status in ('completed','failed') then
    raise exception 'AI job % is % and cannot change', old.id, old.status using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'queued' and new.status in ('running','failed'))
    or (old.status = 'running' and new.status in ('completed','failed'))) then
    raise exception 'AI job cannot go from % to %', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status = 'running' and old.status = 'queued' then new.started_at := clock_timestamp(); end if;
  if new.status in ('completed','failed') then
    new.finished_at := clock_timestamp();
    new.request := old.request - 'input';   -- the model input is kept only while the job runs; the ledger keeps its hash
  end if;
  return new;
end $$;
create trigger guard before insert or update on core.ai_job for each row execute function core.ai_job_guard();

alter table core.ai_job enable row level security;
-- People see the jobs within their perimeter; only the requester (or an agent acting for it) moves its own job.
create policy scope on core.ai_job for select using (core.can_see_arm(platform_id, arm_id));
create policy own_insert on core.ai_job for insert with check (core.can_see_arm(platform_id, arm_id) and requested_by = core.current_sub());
create policy own_update on core.ai_job for update using (core.can_see_arm(platform_id, arm_id) and requested_by = core.current_sub())
  with check (core.can_see_arm(platform_id, arm_id));
grant select, insert on core.ai_job to authenticated;
grant update (status, result, error, ai_request_id) on core.ai_job to authenticated;
