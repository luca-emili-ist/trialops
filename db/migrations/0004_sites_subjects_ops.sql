-- TrialOps · 0004 sites, subjects, regulatory, contracts, documents, deviations, safety
-- Req: M02-01, M02-03, M03-01, M04-01, M05-02, M07-01, M08-02, M09-01, DM-01

create table core.site (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  org_id        uuid not null references core.organization(id),
  site_number   text not null,
  country       text not null,
  declared_capacity_per_month numeric,
  status        text not null default 'candidate' check (status in ('candidate','qualified','active','on_hold','closed','void')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1,
  unique (platform_id, site_number)
);
select core.attach_std('core.site');
alter table core.role_assignment add constraint ra_site_fk foreign key (site_id) references core.site(id);

-- one row per site x arm; each activation step has its own timestamp (M02-03)
create table core.site_arm_activation (
  id                 uuid primary key default gen_random_uuid(),
  platform_id        uuid not null references core.platform(id),
  arm_id             uuid not null references core.arm(id),
  site_id            uuid not null references core.site(id),
  qualified_at       timestamptz,
  contract_executed_at timestamptz,
  irb_approved_at    timestamptz,
  training_done_at   timestamptz,
  green_light_at     timestamptz,
  status             text not null default 'in_progress' check (status in ('in_progress','activated','closed','void')),
  created_at         timestamptz not null default clock_timestamp(),
  updated_at         timestamptz not null default clock_timestamp(),
  row_version        int not null default 1,
  unique (arm_id, site_id)
);
select core.attach_std('core.site_arm_activation');

create or replace function core.site_activation_events() returns trigger language plpgsql as $$
begin
  if new.green_light_at is not null and (tg_op = 'INSERT' or old.green_light_at is null) then
    new.status := 'activated';
    perform core.emit('site.activated', 'site/' || new.site_id, new.platform_id, new.arm_id,
      jsonb_build_object('site_id', new.site_id, 'green_light_at', new.green_light_at));
  end if;
  return new;
end $$;
create trigger activation_events before insert or update on core.site_arm_activation
  for each row execute function core.site_activation_events();

-- pseudonymized subjects only (identity stays at site / eConsent app)
create table core.subject (
  id             uuid primary key default gen_random_uuid(),
  platform_id    uuid not null references core.platform(id),
  site_id        uuid not null references core.site(id),
  subject_code   text not null,
  arm_id         uuid references core.arm(id),          -- set at randomization; blinded views hide it
  status         text not null default 'identified' check (status in
                  ('identified','prescreened','prescreen_failed','consented','screening','screen_failed',
                   'randomized','on_treatment','completed','withdrawn','void')),
  status_changed_at timestamptz not null default clock_timestamp(),
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  row_version    int not null default 1,
  unique (platform_id, subject_code)
);
select core.attach_std('core.subject');

create table core.subject_status_history (
  id          bigserial primary key,
  subject_id  uuid not null references core.subject(id) deferrable initially deferred,
  platform_id uuid not null,
  site_id     uuid not null,
  from_status text,
  to_status   text not null,
  changed_at  timestamptz not null
);

create or replace function core.subject_status() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status <> old.status then
    if tg_op = 'UPDATE' then new.status_changed_at := clock_timestamp(); end if;
    insert into core.subject_status_history(subject_id, platform_id, site_id, from_status, to_status, changed_at)
    values (new.id, new.platform_id, new.site_id, case when tg_op='UPDATE' then old.status end, new.status, new.status_changed_at);
    if new.status in ('prescreened','consented','randomized') then
      perform core.emit('subject.' || new.status, 'subject/' || new.id, new.platform_id, null,
        jsonb_build_object('site_id', new.site_id));   -- never carries arm_id: blinding by default
    end if;
  end if;
  return new;
end $$;
create trigger status_hist before insert or update on core.subject for each row execute function core.subject_status();

-- Blinded view: arm assignment hidden unless unblinded (IAM-04)
create view core.subject_blinded with (security_barrier) as
  select id, platform_id, site_id, subject_code,
         case when core.is_unblinded() then arm_id end as arm_id,
         status, status_changed_at, created_at, updated_at, row_version
  from core.subject
  where core.can_see_platform(platform_id) and core.can_see_site(site_id);

create table core.submission (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  arm_id        uuid references core.arm(id),
  kind          text not null check (kind in ('ind_initial','ind_amendment','irb_initial','irb_amendment','safety_report','annual_report','other')),
  authority     text not null,              -- 'FDA', 'Central IRB', ...
  submitted_at  timestamptz,
  outcome       text check (outcome in ('may_proceed','approved','approved_with_conditions','clinical_hold','rejected')),
  outcome_at    timestamptz,
  status        text not null default 'draft' check (status in ('draft','submitted','closed','void')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.submission');

create or replace function core.submission_events() returns trigger language plpgsql as $$
begin
  if new.outcome is not null and (tg_op='INSERT' or old.outcome is distinct from new.outcome) then
    if new.outcome_at is null then new.outcome_at := clock_timestamp(); end if;
    perform core.emit(case when new.kind like 'irb%' and new.outcome like 'approved%' then 'irb.approved'
                           else 'submission.status.changed' end,
      'submission/' || new.id, new.platform_id, new.arm_id, jsonb_build_object('kind', new.kind, 'outcome', new.outcome));
  end if;
  return new;
end $$;
create trigger submission_events before insert or update on core.submission for each row execute function core.submission_events();

create table core.contract (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  arm_id        uuid references core.arm(id),
  site_id       uuid references core.site(id),
  counterparty_org_id uuid not null references core.organization(id),
  kind          text not null check (kind in ('platform_master','arm_addendum','site_cta','vendor')),
  negotiation_started_at timestamptz,
  executed_at   timestamptz,
  status        text not null default 'draft' check (status in ('draft','negotiation','executed','terminated','void')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.contract');

create or replace function core.contract_events() returns trigger language plpgsql as $$
begin
  if new.executed_at is not null and (tg_op='INSERT' or old.executed_at is null) then
    new.status := 'executed';
    perform core.emit('contract.executed', 'contract/' || new.id, new.platform_id, new.arm_id, jsonb_build_object('kind', new.kind));
  end if;
  return new;
end $$;
create trigger contract_events before insert or update on core.contract for each row execute function core.contract_events();

-- TMF documents (TMF Reference Model classification)
create table core.document (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  arm_id        uuid references core.arm(id),
  site_id       uuid references core.site(id),
  tmf_level     text not null check (tmf_level in ('platform','arm','site')),
  tmf_zone      text,
  tmf_section   text,
  tmf_artifact  text,
  title         text not null,
  status        text not null default 'draft' check (status in ('draft','in_review','approved','superseded','void')),
  classified_by text check (classified_by in ('human','agent')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.document');

create table core.document_version (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references core.document(id),
  version_no    int not null,
  blob_uri      text not null,
  sha256        text not null,
  uploaded_by   text not null default core.current_sub(),
  uploaded_at   timestamptz not null default clock_timestamp(),
  unique (document_id, version_no)
);
create trigger audit after insert on core.document_version for each row execute function core.audit_row('gxp');
create trigger immutable before update or delete on core.document_version for each row execute function core.audit_immutable();

create table core.deviation (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  arm_id        uuid references core.arm(id),
  site_id       uuid references core.site(id),
  subject_id    uuid references core.subject(id),
  category      text not null,
  severity      text check (severity in ('minor','major','critical')),
  detected_by   text not null check (detected_by in ('human','agent','rule')),
  description   text not null,
  status        text not null default 'proposed' check (status in ('proposed','confirmed','rejected','closed','void')),
  detected_at   timestamptz not null default clock_timestamp(),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.deviation');

create table core.adverse_event (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  site_id       uuid not null references core.site(id),
  subject_id    uuid not null references core.subject(id),
  term_verbatim text not null,
  meddra_pt     text,
  serious       boolean not null default false,
  fatal_or_life_threatening boolean not null default false,
  onset_date    date not null,
  aware_at      timestamptz not null default clock_timestamp(),
  report_due_at timestamptz,               -- expedited reporting clock, set by trigger (M07-01)
  status        text not null default 'open' check (status in ('open','reported','closed','void')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1
);
select core.attach_std('core.adverse_event');

-- M07-01: expedited clock (7 days fatal/life-threatening, 15 days other serious); causality and
-- reportability remain human decisions — this only starts the clock.
create or replace function core.ae_clock() returns trigger language plpgsql as $$
begin
  new.report_due_at := case when new.serious and new.fatal_or_life_threatening then new.aware_at + interval '7 days'
                            when new.serious then new.aware_at + interval '15 days' end;
  if tg_op = 'INSERT' then
    perform core.emit(case when new.serious then 'sae.reported' else 'ae.reported' end, 'ae/' || new.id,
      new.platform_id, null, jsonb_build_object('site_id', new.site_id, 'serious', new.serious));
  end if;
  return new;
end $$;
create trigger ae_clock before insert or update on core.adverse_event for each row execute function core.ae_clock();
