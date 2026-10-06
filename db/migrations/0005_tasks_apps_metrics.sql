-- TrialOps · 0005 tasks, time entries, apps, AI ledger, metrics
-- Req: APP-TK-01..07, APP-MF-01..04, AI-06, M11-01, M11-02, IAM-07

create table core.task (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  arm_id        uuid references core.arm(id),
  site_id       uuid references core.site(id),
  type          text not null,
  title         text not null,
  subject_ref   text,                                  -- e.g. 'arm/<uuid>'
  assignee_kind text not null check (assignee_kind in ('person','role','agent','app')),
  assignee      text not null,                         -- person id, role name, agent id or app_id
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  gxp_impact    boolean not null default false,
  requires_signature boolean not null default false,
  inputs        jsonb not null default '{}',
  outputs       jsonb,
  state         text not null default 'created' check (state in
                  ('created','assigned','in_progress','waiting_review','completed','rejected','cancelled','expired')),
  due_at        timestamptz,
  claimed_by    text,
  claimed_at    timestamptz,
  completed_at  timestamptz,
  review_signature_id uuid references core.signature(id),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.task', 'operational');   -- task changes audited, reason not mandatory
create index on core.task (platform_id, state);
create index on core.task (assignee_kind, assignee, state);

create table core.task_event (
  id         bigserial primary key,
  task_id    uuid not null references core.task(id) deferrable initially deferred,
  from_state text,
  to_state   text not null,
  actor_sub  text not null,
  actor_type text not null,
  at         timestamptz not null default clock_timestamp()
);

-- APP-TK-02 state machine, APP-TK-04 gxp review rule
create or replace function core.task_fsm() returns trigger language plpgsql as $$
declare allowed jsonb := '{
  "created":["assigned","cancelled"],
  "assigned":["in_progress","cancelled","expired","assigned"],
  "in_progress":["waiting_review","completed","rejected","cancelled","expired"],
  "waiting_review":["completed","rejected","in_progress"],
  "completed":[], "rejected":[], "cancelled":[], "expired":[]}';
begin
  if tg_op = 'INSERT' then
    insert into core.task_event(task_id, from_state, to_state, actor_sub, actor_type)
      values (new.id, null, new.state, core.current_sub(), core.current_actor_type());
    perform core.emit('task.created', 'task/' || new.id, new.platform_id, new.arm_id,
      jsonb_build_object('type', new.type, 'assignee_kind', new.assignee_kind, 'assignee', new.assignee));
    return new;
  end if;
  if new.state = old.state then return new; end if;
  if not (allowed->old.state) ? new.state then
    raise exception 'task transition % -> % not allowed (APP-TK-02)', old.state, new.state using errcode = 'check_violation';
  end if;
  -- APP-TK-04: GxP work done by an agent or an app must pass human review with a signature
  if new.state = 'completed' and (new.gxp_impact or new.requires_signature) then
    if old.state <> 'waiting_review' and (new.assignee_kind in ('agent','app') or core.current_actor_type() in ('agent','app')) then
      raise exception 'GxP task executed by % must go through waiting_review (APP-TK-04)', new.assignee_kind using errcode='check_violation';
    end if;
    if new.review_signature_id is null then
      raise exception 'GxP task requires a review signature to complete (APP-TK-04)' using errcode='check_violation';
    end if;
    if core.current_actor_type() in ('agent','app') then
      raise exception 'only a person can complete a GxP task (AI-05)' using errcode='insufficient_privilege';
    end if;
  end if;
  if new.state in ('completed','rejected','cancelled','expired') then new.completed_at := clock_timestamp(); end if;
  insert into core.task_event(task_id, from_state, to_state, actor_sub, actor_type)
    values (new.id, old.state, new.state, core.current_sub(), core.current_actor_type());
  if new.state = 'completed' then
    perform core.emit('task.completed', 'task/' || new.id, new.platform_id, new.arm_id, jsonb_build_object('type', new.type));
  end if;
  return new;
end $$;
create trigger fsm before insert or update on core.task for each row execute function core.task_fsm();

create table core.time_entry (
  id          uuid primary key default gen_random_uuid(),
  platform_id uuid not null references core.platform(id),
  arm_id      uuid references core.arm(id),
  person_id   uuid not null references core.person(id),
  task_id     uuid references core.task(id),
  activity    text not null,
  work_date   date not null,
  hours       numeric(5,2) not null check (hours > 0 and hours <= 24),
  status      text not null default 'recorded' check (status in ('recorded','void')),
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  row_version int not null default 1
);
select core.attach_std('core.time_entry', 'operational');

-- Vertical apps (spec §4)
create table core.app_installation (
  id            uuid primary key default gen_random_uuid(),
  app_id        text not null,
  version       text not null,
  manifest      jsonb not null,
  gxp_class     text not null check (gxp_class in ('L0','L1','L2','L3')),
  platform_id   uuid references core.platform(id),
  status        text not null default 'pending_approval' check (status in ('pending_approval','active','suspended','uninstalled','void')),
  approved_by   text,
  approved_at   timestamptz,
  uninstalled_at timestamptz,
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1,
  unique (app_id, platform_id)
);
select core.attach_std('core.app_installation', 'operational');

create table core.app_scope_grant (
  id              uuid primary key default gen_random_uuid(),
  installation_id uuid not null references core.app_installation(id),
  scope           text not null,
  granted_at      timestamptz not null default clock_timestamp(),
  revoked_at      timestamptz,
  unique (installation_id, scope)
);

-- APP-MF-02 / APP-MF-04: approving activates scopes; uninstall revokes them
create or replace function core.app_lifecycle() returns trigger language plpgsql as $$
begin
  if new.status = 'active' and old.status <> 'active' then
    if new.approved_by is null then raise exception 'app activation requires approver (APP-MF-02)'; end if;
    new.approved_at := clock_timestamp();
    insert into core.app_scope_grant(installation_id, scope)
      select new.id, jsonb_array_elements_text(new.manifest->'scopes')
      on conflict (installation_id, scope) do update set revoked_at = null, granted_at = clock_timestamp();
  elsif new.status in ('uninstalled','suspended') and old.status = 'active' then
    update core.app_scope_grant set revoked_at = clock_timestamp() where installation_id = new.id and revoked_at is null;
    if new.status = 'uninstalled' then new.uninstalled_at := clock_timestamp(); end if;
  end if;
  return new;
end $$;
create trigger lifecycle before update on core.app_installation for each row execute function core.app_lifecycle();

create or replace function core.app_has_scope(p_app text, p_platform uuid, p_scope text) returns boolean
language sql stable as $$
  select exists (select 1 from core.app_installation i join core.app_scope_grant g on g.installation_id = i.id
    where i.app_id = p_app and i.platform_id is not distinct from p_platform and i.status = 'active'
      and g.scope = p_scope and g.revoked_at is null)
$$;

-- AI ledger (AI-06), aligned with the AI Gateway spec §15 + GxP fields
create table core.ai_request (
  id              uuid primary key default gen_random_uuid(),
  platform_id     uuid references core.platform(id),
  arm_id          uuid references core.arm(id),
  task_id         uuid references core.task(id),
  task_type       text not null,
  data_class      text not null check (data_class in ('PUBLIC','INTERNAL','CONFIDENTIAL_SPONSOR','CLINICAL_PSEUDONYMIZED','STRICT_LOCAL')),
  provider        text not null,
  model           text not null,
  model_version   text not null,
  prompt_id       text,
  prompt_version  int,
  input_sha256    text not null,
  output_sha256   text,
  input_tokens    int,
  output_tokens   int,
  cost_eur        numeric(12,6),
  latency_ms      int,
  outcome         text check (outcome in ('success','validation_failed','error','timeout','blocked')),
  review_decision text check (review_decision in ('accepted','edited','rejected')),
  reviewer_sub    text,
  requested_by    text not null default core.current_sub(),
  created_at      timestamptz not null default clock_timestamp()
);
create trigger audit after insert on core.ai_request for each row execute function core.audit_row('operational');

-- Policy engine record for agent actions (AI-08; Deontos left out for now, decision 4)
create table core.agent_decision_record (
  id            uuid primary key default gen_random_uuid(),
  agent_id      text not null,
  tool          text not null,
  platform_id   uuid references core.platform(id),
  task_id       uuid references core.task(id),
  request       jsonb not null,
  decision      text not null check (decision in ('ALLOW','REVIEW','BLOCK')),
  policies_applied text[] not null,
  rationale     text not null,
  record_sha256 text not null,
  signature_ed25519 text,                   -- signed by the policy engine runtime, verifiable with published key
  decided_at    timestamptz not null default clock_timestamp()
);
create trigger immutable before update or delete on core.agent_decision_record for each row execute function core.audit_immutable();

-- SURPASS metric catalogue (M11-01). Values are always computed from events, never typed.
create table core.metric_definition (
  code           text primary key,
  ta             text not null,
  name           text not null,
  unit           text not null,
  direction      text not null check (direction in ('lower_is_better','higher_is_better','within_band')),
  interim_target numeric,
  final_target   numeric,
  source_events  text[] not null,
  formula        text not null
);
