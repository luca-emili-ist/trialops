-- TrialOps · 0003 organizations, people, roles, platform, protocol, arms
-- Req: DM-01, DM-02, IAM-02, IAM-03, M01-01, M01-04

create table core.organization (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  org_type    text not null check (org_type in ('lead_operator','sponsor','site','cro','vendor','committee','technology_provider','regulator')),
  is_small_business boolean not null default false,
  country     text,
  status      text not null default 'active' check (status in ('active','inactive','void')),
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  row_version int not null default 1
);
select core.attach_std('core.organization');

create table core.person (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references core.organization(id),
  idp_sub     text unique,                 -- subject from the identity broker
  full_name   text not null,
  email       text not null unique,
  status      text not null default 'active' check (status in ('active','suspended','deactivated','void')),
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  row_version int not null default 1
);
select core.attach_std('core.person');

create table core.platform (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  title        text not null,
  therapeutic_area text not null,          -- configuration only, no clinical logic (spec §1)
  lead_operator_id uuid not null references core.organization(id),
  status       text not null default 'draft' check (status in ('draft','active','suspended','closed','void')),
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  row_version  int not null default 1
);
select core.attach_std('core.platform');

create table core.role_assignment (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references core.person(id),
  role        text not null check (role in ('platform_admin','platform_ops_manager','arm_sponsor_lead','ctm','cra',
                 'site_pi','study_coordinator','regulatory_lead','safety_physician','data_manager','sac_member',
                 'dsmb_member','finance_controller','qa_auditor')),
  platform_id uuid references core.platform(id),
  arm_id      uuid,
  site_id     uuid,
  valid_from  date not null default current_date,
  valid_to    date,
  status      text not null default 'active' check (status in ('active','ended','void')),
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  row_version int not null default 1
);
select core.attach_std('core.role_assignment');

create table core.master_protocol_version (
  id           uuid primary key default gen_random_uuid(),
  platform_id  uuid not null references core.platform(id),
  version_label text not null,
  usdm         jsonb not null default '{}',   -- CDISC USDM structured protocol
  status       text not null default 'draft' check (status in ('draft','in_review','approved','superseded','void')),
  approved_signature_id uuid references core.signature(id),
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  row_version  int not null default 1,
  unique (platform_id, version_label)
);
select core.attach_std('core.master_protocol_version');

create table core.arm (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  code          text not null,
  name          text not null,
  sponsor_org_id uuid references core.organization(id),
  intervention_type text not null check (intervention_type in ('drug','biologic','control')),
  has_prior_human_data boolean,
  approved_any_indication boolean,
  status        text not null default 'draft' check (status in ('draft','approved','active','suspended','closed','graduated','void')),
  current_stage text check (current_stage in ('dose_finding','expansion','efficacy','confirmatory')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1,
  unique (platform_id, code)
);
select core.attach_std('core.arm');
alter table core.role_assignment add constraint ra_arm_fk foreign key (arm_id) references core.arm(id);

create table core.arm_appendix_version (
  id           uuid primary key default gen_random_uuid(),
  platform_id  uuid not null references core.platform(id),
  arm_id       uuid not null references core.arm(id),
  master_protocol_version_id uuid not null references core.master_protocol_version(id),
  version_label text not null,
  usdm         jsonb not null default '{}',
  status       text not null default 'draft' check (status in ('draft','in_review','approved','superseded','void')),
  approved_signature_id uuid references core.signature(id),
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  row_version  int not null default 1,
  unique (arm_id, version_label)
);
select core.attach_std('core.arm_appendix_version');

-- DM-02: approved controlled versions are immutable (only superseded/void transitions allowed)
create or replace function core.freeze_approved() returns trigger language plpgsql as $$
begin
  if old.status = 'approved' and (new.status not in ('approved','superseded','void')
      or new.usdm is distinct from old.usdm or new.version_label is distinct from old.version_label) then
    raise exception 'approved version of % is immutable (DM-02): create a new version', tg_table_name
      using errcode = 'check_violation';
  end if;
  if new.status = 'approved' and old.status <> 'approved' and new.approved_signature_id is null then
    raise exception 'approval requires an approval signature (CMP-02)' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger freeze_approved before update on core.master_protocol_version for each row execute function core.freeze_approved();
create trigger freeze_approved before update on core.arm_appendix_version for each row execute function core.freeze_approved();

-- arm lifecycle (M01-04)
create table core.arm_stage_transition (
  id           uuid primary key default gen_random_uuid(),
  platform_id  uuid not null references core.platform(id),
  arm_id       uuid not null references core.arm(id),
  from_stage   text,
  to_stage     text not null,
  decision_record_id uuid,
  transitioned_at timestamptz not null default clock_timestamp(),
  status       text not null default 'effective' check (status in ('effective','void')),
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  row_version  int not null default 1
);
select core.attach_std('core.arm_stage_transition');

create or replace function core.arm_lifecycle() returns trigger language plpgsql as $$
declare allowed jsonb := '{
  "draft":["approved","void"], "approved":["active","void"], "active":["suspended","closed","graduated"],
  "suspended":["active","closed"], "closed":[], "graduated":[], "void":[]}';
begin
  if tg_op = 'INSERT' then
    perform core.emit('arm.created', 'arm/' || new.id, new.platform_id, new.id, jsonb_build_object('code', new.code));
    return new;
  end if;
  if new.status <> old.status then
    if not (allowed->old.status) ? new.status then
      raise exception 'arm status transition % -> % not allowed (M01-04)', old.status, new.status using errcode='check_violation';
    end if;
    perform core.emit(case when new.status in ('closed','graduated') then 'arm.closed' else 'arm.status.changed' end,
      'arm/' || new.id, new.platform_id, new.id, jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.current_stage is distinct from old.current_stage then
    perform core.emit('arm.stage.changed', 'arm/' || new.id, new.platform_id, new.id,
      jsonb_build_object('from', old.current_stage, 'to', new.current_stage));
  end if;
  return new;
end $$;
create trigger lifecycle_ins after insert on core.arm for each row execute function core.arm_lifecycle();
create trigger lifecycle_upd before update on core.arm for each row execute function core.arm_lifecycle();

create table core.control_sharing_rule (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  control_arm_id uuid not null references core.arm(id),
  investigational_arm_id uuid not null references core.arm(id),
  concurrency   text not null check (concurrency in ('concurrent_only','concurrent_and_nonconcurrent')),
  rationale     text,
  status        text not null default 'active' check (status in ('active','void')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.control_sharing_rule');
