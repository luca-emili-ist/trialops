-- TrialOps · 0026 quality and privacy governance: RBQM, service providers, privacy by design, app validation gate
-- Req: CMP-05 (ICH E6(R3) data governance: critical-to-quality factors, risk-based quality management with risks,
--      key risk indicators and quality tolerance limits with breach detection, reconstruction of every decision and
--      adaptation of an arm, service provider oversight),
--      CMP-08 (privacy by design, GDPR art. 25/32/44, HIPAA §164.312, APPI: pseudonymous subject codes in the core, the
--      re-identification link only in the SAC enclave, record of processing activities as versioned data, DPA/BAA/APPI
--      agreements per provider, data residency per region),
--      VAL-04 (L2-L3 apps are not activated without the accepted supplier validation package and passing contract tests).
-- Design (summary; procedures in docs/compliance/RBQM_AND_PROVIDERS.md and docs/compliance/PRIVACY_BY_DESIGN.md):
--   * every new core table carries core.attach_std (audit, touch, no physical delete) or the audit insert trigger plus the
--     append-only trigger; facts (observations, contract test runs) are append-only;
--   * writes by API callers are guarded by core.governance_guard(<roles>): a person with one of the listed roles; agents
--     and apps never maintain governance records. Time and author come from the server (rule 11);
--   * state changes only through the state-machine triggers below; status 'void' instead of delete;
--   * blinding: nothing here stores or returns the arm of a subject; the arm decision timeline never reads subject rows;
--     the re-identification link lives in sac_enclave, no API role has a grant on it.
-- Grants: select/insert/update on the new core tables to authenticated (RLS on platform-scoped tables), never to
-- app_service or anon; execute on the new functions revoked from public and granted to authenticated. No change to
-- existing grants or RLS policies. Existing tables get additive columns (core.platform.data_region,
-- core.app_installation.validation_package_id / contract_test_run_id), new triggers and one NOT VALID check on
-- core.subject.subject_code (new rows only).
-- Idempotent: it can be run again.

-- =====================================================================================================================
-- helpers
-- =====================================================================================================================
create or replace function core.has_any_role(p_roles text[]) returns boolean language sql stable as $$
  select core.current_actor_type() = 'user' and coalesce(core.jwt()->'roles', '[]'::jsonb) ?| p_roles
$$;

-- BEFORE INSERT/UPDATE guard: callers through the API (authenticated, app_service) must be a person with one of the roles
-- given as trigger arguments. Owners (migrations, seed, security definer functions) are not API callers.
create or replace function core.governance_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'app_service', 'anon') and not core.has_any_role(tg_argv::text[]) then
    raise exception '% is maintained by a person with role % (CMP-05, CMP-08, VAL-04)', tg_table_name, array_to_string(tg_argv, ' or ')
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create or replace function core.privacy_categories() returns text[] language sql immutable as $$
  select array['operational', 'sponsor_confidential', 'pseudonymised_clinical', 'identifiable_health']
$$;
-- Categories that are personal data of trial participants (GDPR art. 4(1)/9, HIPAA PHI, APPI special care-required).
create or replace function core.privacy_personal_categories() returns text[] language sql immutable as $$
  select array['pseudonymised_clinical', 'identifiable_health']
$$;

-- =====================================================================================================================
-- CMP-05 · critical-to-quality factors, risks, KRI / QTL
-- =====================================================================================================================
create table if not exists core.ctq_factor (
  id           uuid primary key default gen_random_uuid(),
  platform_id  uuid not null references core.platform(id),
  arm_id       uuid references core.arm(id),                 -- null = platform level
  code         text not null check (code ~ '^[A-Z0-9][A-Z0-9_.-]{0,39}$'),
  title        text not null check (length(btrim(title)) between 1 and 300),
  category     text not null check (category in ('participant_protection', 'data_reliability', 'trial_conduct', 'other')),
  rationale    text not null check (length(btrim(rationale)) between 1 and 4000),
  status       text not null default 'active' check (status in ('active', 'retired', 'void')),
  created_by   text not null default core.current_sub(),
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  row_version  int not null default 1,
  unique (platform_id, code)
);
comment on table core.ctq_factor is 'Critical-to-quality factors per platform or arm (CMP-05, ICH E6(R3) / E8(R1)); audited, void instead of delete';

create table if not exists core.quality_risk (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  arm_id        uuid references core.arm(id),
  ctq_factor_id uuid not null references core.ctq_factor(id),
  code          text not null check (code ~ '^[A-Z0-9][A-Z0-9_.-]{0,39}$'),
  description   text not null check (length(btrim(description)) between 1 and 4000),
  likelihood    int not null check (likelihood between 1 and 5),
  impact        int not null check (impact between 1 and 5),
  detectability int not null check (detectability between 1 and 5),    -- 5 = hardest to detect
  risk_score    int generated always as (likelihood * impact * detectability) stored,
  controls      text not null check (length(btrim(controls)) between 1 and 4000),
  owner_role    text not null check (owner_role ~ '^[a-z_]{2,40}$'),
  status        text not null default 'open' check (status in ('open', 'mitigated', 'accepted', 'closed', 'void')),
  review_due    date,
  created_by    text not null default core.current_sub(),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1,
  unique (platform_id, code)
);
comment on table core.quality_risk is 'RBQM risk register (CMP-05): likelihood x impact x detectability, controls, owner; audited, state machine';

create table if not exists core.quality_tolerance_limit (
  id            uuid primary key default gen_random_uuid(),
  platform_id   uuid not null references core.platform(id),
  arm_id        uuid references core.arm(id),
  ctq_factor_id uuid not null references core.ctq_factor(id),
  risk_id       uuid references core.quality_risk(id),
  code          text not null check (code ~ '^[A-Z0-9][A-Z0-9_.-]{0,39}$'),
  kind          text not null check (kind in ('KRI', 'QTL')),
  metric        text not null check (metric ~ '^[a-z0-9_.]{1,60}$'),
  description   text not null check (length(btrim(description)) between 1 and 2000),
  unit          text not null check (length(btrim(unit)) between 1 and 40),
  lower_limit   numeric,
  upper_limit   numeric,
  status        text not null default 'active' check (status in ('active', 'retired', 'void')),
  created_by    text not null default core.current_sub(),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1,
  unique (platform_id, code),
  check (lower_limit is not null or upper_limit is not null),
  check (lower_limit is null or upper_limit is null or lower_limit <= upper_limit)
);
comment on table core.quality_tolerance_limit is 'Key risk indicators and quality tolerance limits (CMP-05, ICH E6(R3) §3.10); breach detection on every observation';

create table if not exists core.qtl_observation (
  id             uuid primary key default gen_random_uuid(),
  limit_id       uuid not null references core.quality_tolerance_limit(id),
  platform_id    uuid not null references core.platform(id),
  arm_id         uuid references core.arm(id),
  value          numeric not null,
  source         text not null check (source in ('computed', 'manual')),
  note           text check (length(note) <= 2000),
  breached       boolean not null default false,
  breach_task_id uuid references core.task(id),
  observed_by    text not null default core.current_sub(),
  observed_at    timestamptz not null default clock_timestamp()
);
comment on table core.qtl_observation is 'Observed values of KRIs/QTLs (CMP-05); append-only facts; a breach opens a review task and a domain event';
create index if not exists qtl_observation_limit_idx on core.qtl_observation (limit_id, observed_at desc);

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ctq_factor'::regclass and tgname = 'audit') then
    perform core.attach_std('core.ctq_factor', 'gxp');
    perform core.attach_std('core.quality_risk', 'gxp');
    perform core.attach_std('core.quality_tolerance_limit', 'gxp');
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'core.qtl_observation'::regclass and tgname = 'audit') then
    create trigger audit after insert on core.qtl_observation for each row execute function core.audit_row('gxp');
    create trigger immutable before update or delete on core.qtl_observation for each row execute function core.audit_immutable();
    create trigger immutable_truncate before truncate on core.qtl_observation execute function core.audit_immutable();
  end if;
end $$;

-- Integrity shared by the RBQM records: the arm belongs to the platform, the parent records to the same platform, author
-- and identity fixed, state machine.
create or replace function core.rbqm_integrity() returns trigger language plpgsql as $$
declare v_parent_platform uuid; allowed jsonb;
begin
  if new.arm_id is not null and not exists (select 1 from core.arm a where a.id = new.arm_id and a.platform_id = new.platform_id) then
    raise exception 'arm % does not belong to platform % (CMP-05)', new.arm_id, new.platform_id using errcode = 'check_violation';
  end if;
  if tg_table_name in ('quality_risk', 'quality_tolerance_limit') then
    select platform_id into v_parent_platform from core.ctq_factor where id = new.ctq_factor_id;
    if v_parent_platform is distinct from new.platform_id then
      raise exception 'CtQ factor of another platform (CMP-05)' using errcode = 'check_violation';
    end if;
  end if;
  if tg_table_name = 'quality_tolerance_limit' then
    if new.risk_id is not null then
      if not exists (select 1 from core.quality_risk r where r.id = new.risk_id and r.platform_id = new.platform_id) then
        raise exception 'risk of another platform (CMP-05)' using errcode = 'check_violation';
      end if;
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := core.current_sub();
    new.created_at := clock_timestamp();
    if new.status not in ('active', 'open') then
      raise exception '% starts active/open (CMP-05)', tg_table_name using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.platform_id is distinct from old.platform_id or new.code is distinct from old.code or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'platform, code and author of % cannot change (CMP-05)', tg_table_name using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'void' then
    raise exception 'a void % is closed (DM-03)', tg_table_name using errcode = 'check_violation';
  end if;
  allowed := case tg_table_name
    when 'quality_risk' then '{"open":["mitigated","accepted","closed","void"],"mitigated":["open","closed","void"],
                              "accepted":["open","closed","void"],"closed":["open","void"]}'::jsonb
    else '{"active":["retired","void"],"retired":["active","void"]}'::jsonb end;
  if new.status <> old.status and not coalesce((allowed->old.status) ? new.status, false) then
    raise exception '% status % -> % not allowed (CMP-05)', tg_table_name, old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['ctq_factor', 'quality_risk', 'quality_tolerance_limit'] loop
    if not exists (select 1 from pg_trigger where tgrelid = format('core.%I', t)::regclass and tgname = 'guard') then
      execute format($f$create trigger guard before insert or update on core.%I for each row
        execute function core.governance_guard('platform_admin', 'platform_ops_manager', 'qa_auditor')$f$, t);
      execute format('create trigger integrity before insert or update on core.%I for each row execute function core.rbqm_integrity()', t);
    end if;
  end loop;
end $$;

-- Breach detection: platform, arm, author and time from the database; outside [lower, upper] = breach, which raises the
-- domain event quality.limit.breached and opens a GxP review task for the platform operations manager.
create or replace function core.qtl_observe() returns trigger language plpgsql security definer set search_path = core, public as $$
declare l core.quality_tolerance_limit;
begin
  select * into l from core.quality_tolerance_limit where id = new.limit_id;
  if l.id is null or l.status <> 'active' then
    raise exception 'observations are recorded only on an active KRI/QTL (CMP-05)' using errcode = 'check_violation';
  end if;
  new.platform_id := l.platform_id;
  new.arm_id := l.arm_id;
  new.observed_by := core.current_sub();
  new.observed_at := clock_timestamp();
  new.breached := (l.lower_limit is not null and new.value < l.lower_limit) or (l.upper_limit is not null and new.value > l.upper_limit);
  new.breach_task_id := null;
  if new.breached then
    insert into core.task(platform_id, arm_id, type, title, subject_ref, assignee_kind, assignee, priority, gxp_impact, inputs, state)
    values (l.platform_id, l.arm_id, 'rbqm.breach.review', format('%s %s breached: %s %s', l.kind, l.code, new.value, l.unit),
      'quality_tolerance_limit/' || l.id, 'role', 'platform_ops_manager', case when l.kind = 'QTL' then 'urgent' else 'high' end, true,
      jsonb_build_object('limit_id', l.id, 'code', l.code, 'kind', l.kind, 'metric', l.metric, 'value', new.value,
        'lower_limit', l.lower_limit, 'upper_limit', l.upper_limit), 'assigned')
    returning id into new.breach_task_id;
    perform core.emit('quality.limit.breached', 'quality_tolerance_limit/' || l.id, l.platform_id, l.arm_id,
      jsonb_build_object('code', l.code, 'kind', l.kind, 'metric', l.metric, 'value', new.value, 'task_id', new.breach_task_id));
  end if;
  return new;
end $$;
drop trigger if exists observe on core.qtl_observation;
create trigger observe before insert on core.qtl_observation for each row execute function core.qtl_observe();
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.qtl_observation'::regclass and tgname = 'guard') then
    create trigger guard before insert on core.qtl_observation for each row
      execute function core.governance_guard('platform_admin', 'platform_ops_manager', 'qa_auditor', 'data_manager');
  end if;
end $$;

-- Platform-level metrics computed from the records (never typed). Subject-derived metrics are never computed per arm:
-- that would need the allocation (blinding, rule 5).
create or replace function core.rbqm_metric(p_platform uuid, p_metric text) returns numeric language plpgsql stable as $$
declare v numeric;
begin
  case p_metric
    when 'deviation.major_per_100_randomized' then
      select round(100.0 * (select count(*) from core.deviation d where d.platform_id = p_platform and d.severity in ('major', 'critical')
                              and d.status not in ('rejected', 'void'))
             / nullif(count(*), 0), 2) into v
        from core.subject s where s.platform_id = p_platform and s.status in ('randomized', 'on_treatment', 'completed', 'withdrawn');
    when 'subject.screen_failure_pct' then
      select round(100.0 * count(*) filter (where s.status = 'screen_failed')
             / nullif(count(*) filter (where s.status in ('screen_failed', 'randomized', 'on_treatment', 'completed', 'withdrawn')), 0), 2)
        into v from core.subject s where s.platform_id = p_platform;
    when 'sae.open_overdue' then
      select count(*) into v from core.adverse_event a where a.platform_id = p_platform and a.serious and a.status = 'open'
        and a.report_due_at < clock_timestamp();
    else
      return null;
  end case;
  return v;
end $$;

-- Evaluates every active platform-level KRI/QTL with a computable metric and records one observation each.
create or replace function core.rbqm_evaluate(p_platform uuid) returns setof core.qtl_observation language plpgsql as $$
declare l record; v numeric; o core.qtl_observation;
begin
  if current_user in ('authenticated', 'app_service') and not core.has_any_role(array['platform_admin', 'platform_ops_manager', 'qa_auditor']) then
    raise exception 'evaluating KRIs/QTLs requires platform_admin, platform_ops_manager or qa_auditor (CMP-05)' using errcode = 'insufficient_privilege';
  end if;
  for l in select * from core.quality_tolerance_limit where platform_id = p_platform and status = 'active' and arm_id is null order by code loop
    v := core.rbqm_metric(p_platform, l.metric);
    continue when v is null;
    insert into core.qtl_observation(limit_id, platform_id, value, source) values (l.id, p_platform, v, 'computed') returning * into o;
    return next o;
  end loop;
end $$;

-- =====================================================================================================================
-- CMP-05 · reconstruction of the decisions and adaptations of an arm
-- =====================================================================================================================
-- One time line from the audit trail (arm-level records only, never subject rows), the signatures on those records, the
-- AI requests and agent decisions about the arm and its domain events. For QA auditors and platform admins (people),
-- inside the perimeter of their token.
create or replace function core.arm_decision_timeline(p_arm uuid)
returns table (at timestamptz, source text, kind text, record_table text, record_id uuid, actor text, actor_type text, reason text, detail jsonb)
language plpgsql stable security definer set search_path = core, public as $$
#variable_conflict use_column
declare v_platform uuid;
begin
  perform core.audit_require_reviewer();
  select a.platform_id into v_platform from core.arm a where a.id = p_arm;
  if v_platform is null
     or (core.claim_uuid_list('platform_ids') is not null and not v_platform = any(core.claim_uuid_list('platform_ids')))
     or (core.claim_uuid_list('arm_scopes') is not null and not p_arm = any(core.claim_uuid_list('arm_scopes'))) then
    raise exception 'arm not found in the perimeter of the token (IAM-02)' using errcode = 'insufficient_privilege';
  end if;
  return query
  with arm_audit as (
    select e.* from core.audit_event e
     where e.table_name in ('arm', 'arm_appendix_version', 'arm_stage_transition', 'control_sharing_rule', 'site_arm_activation',
                            'submission', 'contract', 'document', 'task', 'ctq_factor', 'quality_risk', 'quality_tolerance_limit',
                            'qtl_observation')
       and ((e.table_name = 'arm' and e.record_id = p_arm)
         or coalesce(e.new_row, e.old_row)->>'arm_id' = p_arm::text
         or (e.table_name = 'control_sharing_rule' and p_arm::text in (coalesce(e.new_row, e.old_row)->>'control_arm_id',
                                                                        coalesce(e.new_row, e.old_row)->>'investigational_arm_id')))
  )
  select x.at, x.source, x.kind, x.record_table, x.record_id, x.actor, x.actor_type, x.reason, x.detail from (
    select e.occurred_at as at, 'audit'::text as source, e.action as kind, e.table_name as record_table, e.record_id,
           e.actor_sub as actor, e.actor_type, e.reason,
           jsonb_build_object('seq', e.seq, 'hash', e.hash, 'old', e.old_row, 'new', e.new_row) as detail
      from arm_audit e
    union all
    select s.signed_at, 'signature', s.meaning, s.target_table, s.target_id, s.signer_sub, 'user', null,
           jsonb_build_object('signature_id', s.id, 'signer_name', s.signer_name, 'target_hash', s.target_hash, 'auth_method', s.auth_method)
      from core.signature s
     where s.target_id = p_arm or s.target_id in (select a.record_id from arm_audit a where a.record_id is not null)
    union all
    select r.created_at, 'ai_request', r.task_type, 'ai_request', r.id, r.requested_by, 'agent', null,
           jsonb_build_object('provider', r.provider, 'model', r.model, 'model_version', r.model_version, 'prompt_id', r.prompt_id,
             'prompt_version', r.prompt_version, 'outcome', r.outcome, 'review_decision', r.review_decision, 'reviewer_sub', r.reviewer_sub,
             'input_sha256', r.input_sha256, 'output_sha256', r.output_sha256)
      from core.ai_request r where r.arm_id = p_arm
    union all
    select d.decided_at, 'agent_decision', d.decision, 'agent_decision_record', d.id, d.agent_id, 'agent', d.rationale,
           jsonb_build_object('tool', d.tool, 'policies_applied', d.policies_applied, 'record_sha256', d.record_sha256, 'task_id', d.task_id)
      from core.agent_decision_record d join core.task t on t.id = d.task_id where t.arm_id = p_arm
    union all
    select o.time, 'event', o.type, null, null, null, null, null, jsonb_build_object('subject', o.subject, 'data', o.data)
      from core.event_outbox o where o.arm_id = p_arm
  ) x
  order by x.at, x.source, x.record_id;
end $$;
comment on function core.arm_decision_timeline(uuid) is
  'CMP-05: reconstructs the decisions and adaptations of an arm from audit trail, signatures, AI requests, agent decisions and events; reviewers only; no subject rows';

-- =====================================================================================================================
-- CMP-05 / CMP-08 / VAL-04 · service providers, agreements, oversight
-- =====================================================================================================================
create table if not exists core.service_provider (
  id                     uuid primary key default gen_random_uuid(),
  code                   text not null unique check (code ~ '^[a-z0-9][a-z0-9_.-]{1,59}$'),
  name                   text not null check (length(btrim(name)) between 1 and 200),
  org_id                 uuid references core.organization(id),
  kind                   text not null check (kind in ('hosting', 'database', 'ai', 'app_supplier', 'cro', 'laboratory', 'technology', 'other')),
  responsibilities       text not null check (length(btrim(responsibilities)) between 1 and 4000),
  data_categories        text[] not null default '{}',
  processing_regions     text[] not null,
  gxp_relevant           boolean not null default true,
  status                 text not null default 'proposed' check (status in ('proposed', 'qualified', 'active', 'suspended', 'terminated', 'void')),
  review_interval_months int not null default 12 check (review_interval_months between 1 and 60),
  created_by             text not null default core.current_sub(),
  created_at             timestamptz not null default clock_timestamp(),
  updated_at             timestamptz not null default clock_timestamp(),
  row_version            int not null default 1,
  check (data_categories <@ array['operational', 'sponsor_confidential', 'pseudonymised_clinical', 'identifiable_health']),
  check (cardinality(processing_regions) > 0 and processing_regions <@ array['EU', 'US', 'JP'])
);
comment on table core.service_provider is
  'Service providers (CMP-05 oversight, CMP-08 agreements and residency, VAL-04 app suppliers): responsibilities, data categories, processing regions, state machine';

create table if not exists core.provider_agreement (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references core.service_provider(id),
  kind            text not null check (kind in ('DPA', 'BAA', 'APPI_TRANSFER', 'SCC', 'QUALITY_AGREEMENT')),
  data_categories text[] not null default '{}',
  regions         text[] not null default '{}',
  effective_from  date not null,
  expires_on      date,
  document_ref    text not null check (length(btrim(document_ref)) between 1 and 1000),
  document_sha256 text check (document_sha256 ~ '^[0-9a-f]{64}$'),
  status          text not null default 'draft' check (status in ('draft', 'effective', 'terminated', 'void')),
  created_by      text not null default core.current_sub(),
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  row_version     int not null default 1,
  check (data_categories <@ array['operational', 'sponsor_confidential', 'pseudonymised_clinical', 'identifiable_health']),
  check (regions <@ array['EU', 'US', 'JP']),
  check (expires_on is null or expires_on >= effective_from)
);
comment on table core.provider_agreement is 'DPA (GDPR art. 28), BAA (HIPAA), APPI transfer basis, SCC, quality agreement per provider (CMP-08, CMP-05)';
create index if not exists provider_agreement_provider_idx on core.provider_agreement (provider_id, kind, status);

create table if not exists core.provider_oversight_activity (
  id           uuid primary key default gen_random_uuid(),
  provider_id  uuid not null references core.service_provider(id),
  kind         text not null check (kind in ('qualification', 'periodic_review', 'audit', 'kpi_review', 'incident_review', 'requalification')),
  performed_on date not null,
  outcome      text not null check (outcome in ('satisfactory', 'satisfactory_with_findings', 'unsatisfactory')),
  findings     text check (length(findings) <= 4000),
  capa_ref     text check (length(capa_ref) <= 200),
  status       text not null default 'recorded' check (status in ('recorded', 'void')),
  recorded_by  text not null default core.current_sub(),
  recorded_at  timestamptz not null default clock_timestamp(),
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  row_version  int not null default 1,
  check (outcome = 'satisfactory' or length(btrim(coalesce(findings, ''))) > 0)
);
comment on table core.provider_oversight_activity is 'Oversight of service providers (CMP-05, ICH E6(R3) service providers, Annex 11 §3): qualification, reviews, audits';
create index if not exists provider_oversight_provider_idx on core.provider_oversight_activity (provider_id, performed_on desc);

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.service_provider'::regclass and tgname = 'audit') then
    perform core.attach_std('core.service_provider', 'gxp');
    perform core.attach_std('core.provider_agreement', 'gxp');
    perform core.attach_std('core.provider_oversight_activity', 'gxp');
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'core.service_provider'::regclass and tgname = 'guard') then
    create trigger guard before insert or update on core.service_provider for each row
      execute function core.governance_guard('platform_admin', 'qa_auditor');
    create trigger guard before insert or update on core.provider_agreement for each row
      execute function core.governance_guard('platform_admin', 'qa_auditor');
    create trigger guard before insert or update on core.provider_oversight_activity for each row
      execute function core.governance_guard('qa_auditor', 'platform_admin');
  end if;
end $$;

-- Agreements a provider needs: for every participant-data category and region the law of that region (EU: GDPR art. 28
-- DPA; US: HIPAA BAA; JP: APPI basis for providing the data to the provider), plus a written quality agreement when the
-- provider performs GxP-relevant activities (ICH E6(R3) service providers, Annex 11 §3).
create or replace function core.privacy_required_agreements(p_categories text[], p_regions text[], p_gxp boolean)
returns table (kind text, category text, region text) language sql immutable as $$
  select case r when 'EU' then 'DPA' when 'US' then 'BAA' when 'JP' then 'APPI_TRANSFER' end, c, r
    from unnest(coalesce(p_categories, '{}')) c, unnest(coalesce(p_regions, '{}')) r
   where c = any(core.privacy_personal_categories())
  union all
  select 'QUALITY_AGREEMENT', null::text, null::text where coalesce(p_gxp, false)
$$;

-- Required agreements not covered by an effective agreement valid on p_on.
create or replace function core.provider_agreement_gaps(p_provider uuid, p_categories text[], p_regions text[], p_gxp boolean,
  p_on date default current_date) returns table (kind text, category text, region text) language sql stable as $$
  select q.kind, q.category, q.region
    from core.privacy_required_agreements(p_categories, p_regions, p_gxp) q
   where not exists (select 1 from core.provider_agreement a
                      where a.provider_id = p_provider and a.kind = q.kind and a.status = 'effective'
                        and a.effective_from <= p_on and (a.expires_on is null or a.expires_on >= p_on)
                        and (q.category is null or q.category = any(a.data_categories))
                        and (q.region is null or q.region = any(a.regions)))
   order by 1, 2, 3
$$;

-- Last oversight activity and next review date of every provider (computed, never typed).
create or replace function core.provider_oversight_status(p_on date default current_date)
returns table (provider_id uuid, code text, name text, kind text, status text, last_activity_on date, last_activity_kind text,
               last_outcome text, next_review_due date, overdue boolean, agreement_gaps int)
language sql stable as $$
  select p.id, p.code, p.name, p.kind, p.status, la.performed_on, la.kind, la.outcome,
         (la.performed_on + make_interval(months => p.review_interval_months))::date,
         p.status in ('qualified', 'active') and (la.performed_on is null or (la.performed_on + make_interval(months => p.review_interval_months))::date < p_on),
         (select count(*)::int from core.provider_agreement_gaps(p.id, p.data_categories, p.processing_regions, p.gxp_relevant, p_on))
    from core.service_provider p
    left join lateral (select o.performed_on, o.kind, o.outcome from core.provider_oversight_activity o
                        where o.provider_id = p.id and o.status = 'recorded' order by o.performed_on desc, o.recorded_at desc limit 1) la on true
   where p.status <> 'void'
   order by p.code
$$;

create or replace function core.service_provider_fsm() returns trigger language plpgsql as $$
declare allowed jsonb := '{"proposed":["qualified","void"],"qualified":["active","terminated","void"],"active":["suspended","terminated"],
                          "suspended":["active","terminated"],"terminated":[],"void":[]}';
  v_gaps text; v_last record;
begin
  if tg_op = 'INSERT' then
    new.created_by := core.current_sub(); new.created_at := clock_timestamp();
    if new.status <> 'proposed' then
      raise exception 'a service provider starts as proposed and is qualified before activation (CMP-05)' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.code is distinct from old.code or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'code and author of a service provider cannot change (CMP-05)' using errcode = 'insufficient_privilege';
  end if;
  if new.status <> old.status and not coalesce((allowed->old.status) ? new.status, false) then
    raise exception 'service provider status % -> % not allowed (CMP-05)', old.status, new.status using errcode = 'check_violation';
  end if;
  select o.performed_on, o.kind, o.outcome into v_last from core.provider_oversight_activity o
   where o.provider_id = new.id and o.status = 'recorded' order by o.performed_on desc, o.recorded_at desc limit 1;
  if new.status = 'qualified' and old.status = 'proposed' then
    if not exists (select 1 from core.provider_oversight_activity o where o.provider_id = new.id and o.status = 'recorded'
                     and o.kind in ('qualification', 'audit', 'requalification') and o.outcome <> 'unsatisfactory') then
      raise exception 'qualification of provider % needs a recorded qualification or audit with a satisfactory outcome (CMP-05)', new.code
        using errcode = 'check_violation';
    end if;
  end if;
  -- activation, and any change of what an active provider processes: agreements and oversight must be in order
  if new.status = 'active' and (old.status <> 'active' or new.data_categories is distinct from old.data_categories
       or new.processing_regions is distinct from old.processing_regions or new.gxp_relevant is distinct from old.gxp_relevant) then
    select string_agg(g.kind || coalesce(' ' || g.category, '') || coalesce('/' || g.region, ''), ', ') into v_gaps
      from core.provider_agreement_gaps(new.id, new.data_categories, new.processing_regions, new.gxp_relevant) g;
    if v_gaps is not null then
      raise exception 'provider % cannot be active without a valid agreement: missing %  (CMP-08)', new.code, v_gaps using errcode = 'check_violation';
    end if;
    if v_last.outcome is null or v_last.outcome = 'unsatisfactory' then
      raise exception 'provider % has no satisfactory oversight activity (CMP-05)', new.code using errcode = 'check_violation';
    end if;
    if (v_last.performed_on + make_interval(months => new.review_interval_months))::date < current_date then
      raise exception 'oversight review of provider % is overdue (CMP-05)', new.code using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists fsm on core.service_provider;
create trigger fsm before insert or update on core.service_provider for each row execute function core.service_provider_fsm();

-- An effective agreement is a controlled document: only its termination (or void before effect) is a later change.
create or replace function core.provider_agreement_fsm() returns trigger language plpgsql as $$
declare allowed jsonb := '{"draft":["effective","void"],"effective":["terminated"],"terminated":[],"void":[]}';
begin
  if tg_op = 'INSERT' then
    new.created_by := core.current_sub(); new.created_at := clock_timestamp();
    if new.status not in ('draft', 'effective') then
      raise exception 'an agreement starts as draft or effective (CMP-08)' using errcode = 'check_violation';
    end if;
  else
    if new.status <> old.status and not coalesce((allowed->old.status) ? new.status, false) then
      raise exception 'agreement status % -> % not allowed (CMP-08)', old.status, new.status using errcode = 'check_violation';
    end if;
    if old.status <> 'draft' and (new.provider_id, new.kind, new.data_categories, new.regions, new.effective_from, new.expires_on,
          new.document_ref, new.document_sha256) is distinct from (old.provider_id, old.kind, old.data_categories, old.regions,
          old.effective_from, old.expires_on, old.document_ref, old.document_sha256) then
      raise exception 'an effective agreement cannot be edited: record a new one (CMP-08, DM-02)' using errcode = 'check_violation';
    end if;
  end if;
  if new.status = 'effective' and new.document_sha256 is null then
    raise exception 'an effective agreement needs the SHA-256 of the signed document (CMP-08)' using errcode = 'check_violation';
  end if;
  if new.kind in ('DPA', 'BAA', 'APPI_TRANSFER', 'SCC')
     and (cardinality(new.regions) = 0 or not new.data_categories && core.privacy_personal_categories()) then
    raise exception '% must name the participant-data categories and regions it covers (CMP-08)', new.kind using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists fsm on core.provider_agreement;
create trigger fsm before insert or update on core.provider_agreement for each row execute function core.provider_agreement_fsm();

create or replace function core.provider_oversight_fsm() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.recorded_by := core.current_sub(); new.recorded_at := clock_timestamp();
    if new.status <> 'recorded' then raise exception 'an oversight activity is recorded first (CMP-05)' using errcode = 'check_violation'; end if;
    if new.performed_on > current_date then
      raise exception 'an oversight activity cannot be recorded before it happened (CMP-05)' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status = 'void' or (row(new.provider_id, new.kind, new.performed_on, new.outcome, new.findings, new.capa_ref, new.recorded_by, new.recorded_at)
       is distinct from row(old.provider_id, old.kind, old.performed_on, old.outcome, old.findings, old.capa_ref, old.recorded_by, old.recorded_at)) then
    raise exception 'a recorded oversight activity can only be voided (DM-03)' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists fsm on core.provider_oversight_activity;
create trigger fsm before insert or update on core.provider_oversight_activity for each row execute function core.provider_oversight_fsm();

-- =====================================================================================================================
-- CMP-08 · data residency per platform and use of providers on a platform
-- =====================================================================================================================
alter table core.platform add column if not exists data_region text check (data_region in ('EU', 'US', 'JP'));
comment on column core.platform.data_region is 'Region where the data of the platform stays (CMP-08, rule 15): EU, US or JP; set once';

create or replace function core.platform_region_fixed() returns trigger language plpgsql as $$
begin
  if old.data_region is not null and new.data_region is distinct from old.data_region then
    raise exception 'the data region of a platform is set once: its data stays in % (CMP-08)', old.data_region using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists region_fixed on core.platform;
create trigger region_fixed before update on core.platform for each row execute function core.platform_region_fixed();

create table if not exists core.platform_provider (
  id              uuid primary key default gen_random_uuid(),
  platform_id     uuid not null references core.platform(id),
  provider_id     uuid not null references core.service_provider(id),
  data_categories text[] not null default '{}',
  purpose         text not null check (length(btrim(purpose)) between 1 and 1000),
  status          text not null default 'active' check (status in ('active', 'ended', 'void')),
  created_by      text not null default core.current_sub(),
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  row_version     int not null default 1,
  check (data_categories <@ array['operational', 'sponsor_confidential', 'pseudonymised_clinical', 'identifiable_health'])
);
comment on table core.platform_provider is 'Providers used by a platform and the data categories they receive (CMP-08): residency and agreements checked on activation';
create unique index if not exists platform_provider_active_idx on core.platform_provider (platform_id, provider_id) where status = 'active';

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.platform_provider'::regclass and tgname = 'audit') then
    perform core.attach_std('core.platform_provider', 'gxp');
    create trigger guard before insert or update on core.platform_provider for each row
      execute function core.governance_guard('platform_admin', 'qa_auditor');
  end if;
end $$;

create or replace function core.platform_provider_check() returns trigger language plpgsql as $$
declare p core.service_provider; v_region text; v_personal text[]; v_gaps text;
begin
  if tg_op = 'UPDATE' and (new.platform_id is distinct from old.platform_id or new.provider_id is distinct from old.provider_id) then
    raise exception 'platform and provider of a provider use cannot change (CMP-08)' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and old.status <> 'active' and new.status <> old.status then
    raise exception 'an ended provider use is closed: record a new one (CMP-08)' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then new.created_by := core.current_sub(); new.created_at := clock_timestamp(); end if;
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active' and new.data_categories is not distinct from old.data_categories) then
    return new;
  end if;
  select * into p from core.service_provider where id = new.provider_id;
  if p.status <> 'active' then
    raise exception 'provider % is % and cannot be used (CMP-05, CMP-08)', p.code, p.status using errcode = 'check_violation';
  end if;
  if not new.data_categories <@ p.data_categories then
    raise exception 'provider % is not registered for the data categories % (CMP-08)', p.code, new.data_categories using errcode = 'check_violation';
  end if;
  v_personal := array(select c from unnest(new.data_categories) c where c = any(core.privacy_personal_categories()));
  if cardinality(v_personal) > 0 then
    select data_region into v_region from core.platform where id = new.platform_id;
    if v_region is null then
      raise exception 'the platform has no data region: participant data cannot be given to a provider (CMP-08)' using errcode = 'check_violation';
    end if;
    if not v_region = any(p.processing_regions) then
      raise exception 'data residency: provider % processes in %, the platform data stays in % (CMP-08, GDPR art. 44, APPI art. 28)',
        p.code, array_to_string(p.processing_regions, ','), v_region using errcode = 'check_violation';
    end if;
    select string_agg(g.kind || coalesce(' ' || g.category, '') || coalesce('/' || g.region, ''), ', ') into v_gaps
      from core.provider_agreement_gaps(p.id, v_personal, array[v_region], false) g;
    if v_gaps is not null then
      raise exception 'provider % has no valid agreement for this platform: missing % (CMP-08)', p.code, v_gaps using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists checks on core.platform_provider;
create trigger checks before insert or update on core.platform_provider for each row execute function core.platform_provider_check();

-- Can participant data of category p_category of a platform go to provider p_code now? For runtimes (e.g. AI routing).
create or replace function core.provider_allowed(p_platform uuid, p_code text, p_category text) returns boolean language sql stable as $$
  select exists (select 1 from core.platform_provider u join core.service_provider p on p.id = u.provider_id
                  join core.platform pl on pl.id = u.platform_id
                  where u.platform_id = p_platform and p.code = p_code and u.status = 'active' and p.status = 'active'
                    and p_category = any(u.data_categories)
                    and (not p_category = any(core.privacy_personal_categories())
                         or (pl.data_region = any(p.processing_regions)
                             and not exists (select 1 from core.provider_agreement_gaps(p.id, array[p_category], array[pl.data_region], false)))))
$$;

-- =====================================================================================================================
-- CMP-08 · pseudonymisation: subject codes in the core, re-identification link only in the enclave
-- =====================================================================================================================
-- Subject codes are pseudonyms (site number + sequence): no names, e-mails, dates or spaces. NOT VALID: checked for new
-- and changed rows; existing rows are reported by core.privacy_check().
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'core.subject'::regclass and conname = 'subject_code_pseudonym') then
    alter table core.subject add constraint subject_code_pseudonym check (subject_code ~ '^[A-Z0-9][A-Z0-9-]{1,39}$') not valid;
  end if;
end $$;

create table if not exists sac_enclave.reidentification_key (
  id           uuid primary key default gen_random_uuid(),
  platform_id  uuid not null references core.platform(id),
  subject_id   uuid not null references core.subject(id),
  site_id      uuid not null references core.site(id),
  custodian    text not null check (custodian in ('site', 'econsent_app')),
  identity_ref text not null check (length(btrim(identity_ref)) between 1 and 500),   -- opaque reference held by the custodian
  key_id       text not null check (key_id ~ '^[A-Za-z0-9_.:/-]{1,200}$'),            -- id of the pseudonymisation key in the vault
  status       text not null default 'active' check (status in ('active', 'void')),
  created_by   text not null default core.current_sub(),
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  row_version  int not null default 1
);
comment on table sac_enclave.reidentification_key is
  'Link subject pseudonym -> identity record kept by the custodian (CMP-08, GDPR art. 4(5)/25); enclave only, no API grant, written and read only by functions';
create unique index if not exists reidentification_key_subject_idx on sac_enclave.reidentification_key (subject_id) where status = 'active';

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'sac_enclave.reidentification_key'::regclass and tgname = 'audit') then
    perform core.attach_std('sac_enclave.reidentification_key', 'gxp');   -- audit rows of sac_enclave never reach audit_search (0019)
  end if;
end $$;
revoke all on sac_enclave.reidentification_key from public, anon, authenticated, app_service, unblinded;

-- True if any API role could read the link table directly (privacy self-check; the caller has no usage on the enclave).
create or replace function core.reidentification_key_exposed() returns boolean language sql stable security definer set search_path = core, public as $$
  select has_table_privilege('authenticated', 'sac_enclave.reidentification_key', 'select')
      or has_table_privilege('app_service', 'sac_enclave.reidentification_key', 'select')
      or has_table_privilege('unblinded', 'sac_enclave.reidentification_key', 'select')
      or has_table_privilege('anon', 'sac_enclave.reidentification_key', 'select')
      or has_schema_privilege('authenticated', 'sac_enclave', 'usage') or has_schema_privilege('app_service', 'sac_enclave', 'usage')
      or has_schema_privilege('anon', 'sac_enclave', 'usage')
$$;

-- Write-only door for the site or the eConsent app: registers the link, returns only its id.
create or replace function core.register_reidentification(p_subject uuid, p_custodian text, p_identity_ref text, p_key_id text)
returns uuid language plpgsql security definer set search_path = core, sac_enclave, public as $$
declare s record; v_id uuid;
begin
  if core.current_actor_type() = 'app' then
    null;
  elsif not core.has_any_role(array['site_pi', 'study_coordinator']) then
    raise exception 're-identification links are registered by the site or the eConsent app (CMP-08)' using errcode = 'insufficient_privilege';
  end if;
  select id, platform_id, site_id into s from core.subject where id = p_subject;
  if s.id is null or not core.can_see_platform(s.platform_id) or not core.can_see_site(s.site_id)
     or (core.claim_uuid_list('platform_ids') is not null and not s.platform_id = any(core.claim_uuid_list('platform_ids')))
     or (core.claim_uuid_list('site_scopes') is not null and not s.site_id = any(core.claim_uuid_list('site_scopes'))) then
    raise exception 'subject not found in the perimeter of the token (IAM-02)' using errcode = 'insufficient_privilege';
  end if;
  insert into sac_enclave.reidentification_key(platform_id, subject_id, site_id, custodian, identity_ref, key_id)
  values (s.platform_id, s.id, s.site_id, p_custodian, btrim(p_identity_ref), p_key_id) returning id into v_id;
  return v_id;
end $$;

-- Read path: unblinded SAC person only, with a reason, logged like every enclave read (CMP-13).
create or replace function sac_enclave.reidentify(p_subject uuid, p_reason text)
returns table (subject_id uuid, custodian text, identity_ref text, key_id text)
language plpgsql security definer set search_path = core, sac_enclave, public as $$
#variable_conflict use_column
declare v_platform uuid; v_n int;
begin
  if core.current_actor_type() <> 'user' or coalesce(core.jwt()->>'blinding', 'blinded') <> 'unblinded' then
    raise exception 're-identification is for unblinded SAC persons only (CMP-08, IAM-04, IAM-07)' using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 're-identification needs a reason (CMP-08, CMP-13)' using errcode = 'check_violation';
  end if;
  select k.platform_id, count(*) over () into v_platform, v_n from sac_enclave.reidentification_key k
   where k.subject_id = p_subject and k.status = 'active' limit 1;
  insert into core.data_access_log(actor_sub, actor_type, actor_email, kind, object, platform_id, record_id, filters, row_count, reason)
  values (core.current_sub(), core.current_actor_type(), lower(nullif(core.jwt()->>'email', '')), 'unblinded_read',
    'sac_enclave.reidentification_key', v_platform, p_subject, jsonb_build_object('subject_id', p_subject), coalesce(v_n, 0), btrim(p_reason));
  return query select k.subject_id, k.custodian, k.identity_ref, k.key_id from sac_enclave.reidentification_key k
    where k.subject_id = p_subject and k.status = 'active';
end $$;

-- =====================================================================================================================
-- CMP-08 · record of processing activities (GDPR art. 30), versioned
-- =====================================================================================================================
create table if not exists core.ropa_entry (
  id                      uuid primary key default gen_random_uuid(),
  code                    text not null check (code ~ '^ROPA-[0-9]{3}$'),
  version                 int not null check (version >= 1),
  title                   text not null check (length(btrim(title)) between 1 and 300),
  controller              text not null check (length(btrim(controller)) between 1 and 300),
  purpose                 text not null check (length(btrim(purpose)) between 1 and 4000),
  legal_basis_eu          text check (length(legal_basis_eu) <= 1000),
  legal_basis_us          text check (length(legal_basis_us) <= 1000),
  legal_basis_jp          text check (length(legal_basis_jp) <= 1000),
  data_subject_categories text[] not null check (cardinality(data_subject_categories) > 0),
  data_categories         text[] not null check (cardinality(data_categories) > 0),
  recipients              text[] not null default '{}',     -- service_provider codes
  regions                 text[] not null check (cardinality(regions) > 0),
  transfers               text not null default 'none' check (length(btrim(transfers)) between 1 and 2000),
  retention               text not null check (length(btrim(retention)) between 1 and 1000),
  security_measures       text not null check (length(btrim(security_measures)) between 1 and 4000),
  status                  text not null default 'draft' check (status in ('draft', 'approved', 'superseded', 'void')),
  approved_by             text,
  approved_at             timestamptz,
  created_by              text not null default core.current_sub(),
  created_at              timestamptz not null default clock_timestamp(),
  updated_at              timestamptz not null default clock_timestamp(),
  row_version             int not null default 1,
  unique (code, version),
  check (data_categories <@ array['operational', 'sponsor_confidential', 'pseudonymised_clinical', 'identifiable_health']),
  check (regions <@ array['EU', 'US', 'JP'])
);
comment on table core.ropa_entry is 'Record of processing activities (CMP-08, GDPR art. 30): one row per version; approved versions immutable';
create unique index if not exists ropa_entry_approved_idx on core.ropa_entry (code) where status = 'approved';

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ropa_entry'::regclass and tgname = 'audit') then
    perform core.attach_std('core.ropa_entry', 'gxp');
    create trigger guard before insert or update on core.ropa_entry for each row execute function core.governance_guard('platform_admin', 'qa_auditor');
  end if;
end $$;

create or replace function core.ropa_controls() returns trigger language plpgsql as $$
declare v_next int; v_missing text;
begin
  if tg_op = 'INSERT' then
    select coalesce(max(version), 0) + 1 into v_next from core.ropa_entry where code = new.code;
    if new.version <> v_next then
      raise exception 'next version of % is % (CMP-08)', new.code, v_next using errcode = 'check_violation';
    end if;
    if new.status <> 'draft' then raise exception 'a ROPA version starts as draft (CMP-08)' using errcode = 'check_violation'; end if;
    new.created_by := core.current_sub(); new.created_at := clock_timestamp(); new.approved_by := null; new.approved_at := null;
  else
    if old.status in ('superseded', 'void') then
      raise exception 'a % ROPA version is closed (CMP-08)', old.status using errcode = 'check_violation';
    end if;
    if old.status = 'approved' then
      if new.status not in ('superseded', 'void') or (to_jsonb(new) - array['status', 'updated_at', 'row_version'])
                                                     is distinct from (to_jsonb(old) - array['status', 'updated_at', 'row_version']) then
        raise exception 'an approved ROPA version is immutable: create a new version (CMP-08, DM-02)' using errcode = 'check_violation';
      end if;
      return new;
    end if;
    if new.code is distinct from old.code or new.version is distinct from old.version or new.created_by is distinct from old.created_by then
      raise exception 'code, version and author of a ROPA entry cannot change (CMP-08)' using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'superseded' then raise exception 'only an approved version is superseded (CMP-08)' using errcode = 'check_violation'; end if;
    if new.status = 'approved' then
      if current_user in ('authenticated', 'app_service') and core.current_sub() = old.created_by then
        raise exception 'the author of a ROPA version cannot approve it (IAM-05)' using errcode = 'insufficient_privilege';
      end if;
      select string_agg(r, ', ') into v_missing from unnest(new.regions) r
       where (r = 'EU' and length(btrim(coalesce(new.legal_basis_eu, ''))) = 0)
          or (r = 'US' and length(btrim(coalesce(new.legal_basis_us, ''))) = 0)
          or (r = 'JP' and length(btrim(coalesce(new.legal_basis_jp, ''))) = 0);
      if v_missing is not null then
        raise exception 'legal basis missing for region % (CMP-08)', v_missing using errcode = 'check_violation';
      end if;
      select string_agg(x, ', ') into v_missing from unnest(new.recipients) x
       where not exists (select 1 from core.service_provider p where p.code = x and p.status <> 'void');
      if v_missing is not null then
        raise exception 'recipients not in the service provider registry: % (CMP-08)', v_missing using errcode = 'check_violation';
      end if;
      new.approved_by := core.current_sub(); new.approved_at := clock_timestamp();
      update core.ropa_entry set status = 'superseded' where code = new.code and status = 'approved' and id <> new.id;
    elsif new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
      raise exception 'approval fields are set by the database (CMP-08)' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists controls on core.ropa_entry;
create trigger controls before insert or update on core.ropa_entry for each row execute function core.ropa_controls();

-- =====================================================================================================================
-- CMP-08 · privacy self-check (pseudonymisation, minimisation, blinding grants, residency, agreements, ROPA)
-- =====================================================================================================================
create or replace function core.privacy_check(p_platform uuid default null)
returns table (check_code text, subject text, ok boolean, detail text) language plpgsql stable as $$
#variable_conflict use_column
declare r record; v text; v_n int;
begin
  -- minimisation / pseudonymisation: no direct identifiers of participants in the core (people of the platform staff,
  -- organizations and site investigators are not participants)
  if current_user in ('authenticated', 'app_service') and not core.has_any_role(array['qa_auditor', 'platform_admin']) then
    raise exception 'the privacy check is for qa_auditor or platform_admin (CMP-08)' using errcode = 'insufficient_privilege';
  end if;
  -- participant tables: core.subject and every core table that references a subject (pg_catalog: not filtered by privileges)
  select string_agg(c.relname || '.' || a.attname, ', ' order by c.relname, a.attname) into v
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'core' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
     and (c.relname = 'subject' or exists (select 1 from pg_attribute x where x.attrelid = c.oid and x.attname = 'subject_id' and not x.attisdropped))
     and a.attname ~* '(^|_)(first_?name|last_?name|full_?name|given_?name|surname|birth|dob|ssn|social_security|phone|e?mail|address|postcode|zip|mrn|medical_record|national_id|passport|initials)($|_)';
  return query select 'minimisation.no_direct_identifiers', 'core', v is null, coalesce('identifier-like columns: ' || v, 'none');

  select count(*)::int into v_n from core.subject s where not s.subject_code ~ '^[A-Z0-9][A-Z0-9-]{1,39}$'
     and (p_platform is null or s.platform_id = p_platform);
  return query select 'pseudonymisation.subject_codes', 'core.subject', v_n = 0, v_n || ' subject codes not in pseudonym form';

  return query select 'pseudonymisation.key_in_enclave_only', 'sac_enclave.reidentification_key', not core.reidentification_key_exposed(),
    'no API role can read the re-identification link';

  return query select 'blinding.subject_arm_not_readable', 'core.subject.arm_id',
    not (has_column_privilege('authenticated', 'core.subject', 'arm_id', 'select') or has_column_privilege('app_service', 'core.subject', 'arm_id', 'select')),
    'blinded users, agents and apps cannot read the allocation';

  for r in select p.id, p.code, p.data_region from core.platform p where p.status <> 'void' and (p_platform is null or p.id = p_platform) order by p.code loop
    return query select 'residency.region_declared', r.code, r.data_region is not null, coalesce('data stays in ' || r.data_region, 'no data region');
    select string_agg(sp.code, ', ') into v from core.platform_provider u join core.service_provider sp on sp.id = u.provider_id
     where u.platform_id = r.id and u.status = 'active' and u.data_categories && core.privacy_personal_categories()
       and (r.data_region is null or not r.data_region = any(sp.processing_regions) or sp.status <> 'active'
            or exists (select 1 from core.provider_agreement_gaps(sp.id,
                         array(select c from unnest(u.data_categories) c where c = any(core.privacy_personal_categories())),
                         array[r.data_region], false)));
    return query select 'residency.providers_in_region', r.code, v is null, coalesce('out of region or without agreement: ' || v, 'all providers in region with agreements');
  end loop;

  for r in select s.* from core.provider_oversight_status() s where s.status = 'active' loop
    return query select 'agreements.valid', r.code, r.agreement_gaps = 0, r.agreement_gaps || ' missing or expired agreements';
    return query select 'oversight.review_current', r.code, not r.overdue, coalesce('next review ' || r.next_review_due::text, 'never reviewed');
  end loop;

  select string_agg(sp.code, ', ') into v from core.service_provider sp
   where sp.status = 'active' and sp.data_categories && core.privacy_personal_categories()
     and not exists (select 1 from core.ropa_entry e where e.status = 'approved' and sp.code = any(e.recipients));
  return query select 'ropa.recipients_recorded', 'core.ropa_entry',
    v is null and exists (select 1 from core.ropa_entry e where e.status = 'approved'),
    coalesce('active providers with participant data not in an approved ROPA entry: ' || v,
             case when exists (select 1 from core.ropa_entry e where e.status = 'approved') then 'every recipient recorded' else 'no approved ROPA entry' end);
end $$;

-- =====================================================================================================================
-- VAL-04 · supplier validation package and contract tests before activating L2-L3 apps
-- =====================================================================================================================
create table if not exists core.app_validation_package (
  id             uuid primary key default gen_random_uuid(),
  app_id         text not null check (app_id ~ '^[a-z0-9][a-z0-9_.-]{1,99}$'),
  version        text not null check (length(btrim(version)) between 1 and 50),
  gxp_class      text not null check (gxp_class in ('L0', 'L1', 'L2', 'L3')),
  provider_id    uuid not null references core.service_provider(id),
  package_uri    text not null check (length(btrim(package_uri)) between 1 and 1000),
  package_sha256 text not null check (package_sha256 ~ '^[0-9a-f]{64}$'),
  contents       text[] not null default '{}',
  status         text not null default 'received' check (status in ('received', 'accepted', 'rejected', 'superseded', 'void')),
  review_note    text check (length(review_note) <= 4000),
  reviewed_by    text,
  reviewed_at    timestamptz,
  received_by    text not null default core.current_sub(),
  received_at    timestamptz not null default clock_timestamp(),
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  row_version    int not null default 1,
  check (contents <@ array['URS', 'functional_spec', 'risk_assessment', 'test_plan', 'test_evidence', 'traceability', 'release_note', 'sbom', 'security_assessment'])
);
comment on table core.app_validation_package is 'Supplier validation package of an app version (VAL-04, Annex 11 §3/§4, ICH E6(R3)); reviewed by QA';
create unique index if not exists app_validation_package_open_idx on core.app_validation_package (app_id, version) where status in ('received', 'accepted');

create table if not exists core.app_contract_test_run (
  id              uuid primary key default gen_random_uuid(),
  app_id          text not null check (app_id ~ '^[a-z0-9][a-z0-9_.-]{1,99}$'),
  version         text not null check (length(btrim(version)) between 1 and 50),
  suite           text not null check (suite ~ '^[a-z0-9][a-z0-9_.-]{1,99}$'),
  suite_version   text not null check (length(btrim(suite_version)) between 1 and 50),
  passed          int not null check (passed >= 0),
  failed          int not null check (failed >= 0),
  skipped         int not null default 0 check (skipped >= 0),
  result          text generated always as (case when failed = 0 and passed > 0 then 'pass' else 'fail' end) stored,
  evidence_uri    text not null check (length(btrim(evidence_uri)) between 1 and 1000),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by     text not null default core.current_sub(),
  executed_at     timestamptz not null default clock_timestamp()
);
comment on table core.app_contract_test_run is 'Contract test results of an app version against the TrialOps API contract (VAL-04); append-only facts';
create index if not exists app_contract_test_run_idx on core.app_contract_test_run (app_id, version, executed_at desc);

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.app_validation_package'::regclass and tgname = 'audit') then
    perform core.attach_std('core.app_validation_package', 'gxp');
    create trigger guard before insert or update on core.app_validation_package for each row
      execute function core.governance_guard('qa_auditor', 'platform_admin');
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'core.app_contract_test_run'::regclass and tgname = 'audit') then
    create trigger audit after insert on core.app_contract_test_run for each row execute function core.audit_row('gxp');
    create trigger immutable before update or delete on core.app_contract_test_run for each row execute function core.audit_immutable();
    create trigger immutable_truncate before truncate on core.app_contract_test_run execute function core.audit_immutable();
    create trigger guard before insert on core.app_contract_test_run for each row execute function core.governance_guard('qa_auditor', 'platform_admin');
  end if;
end $$;

create or replace function core.app_validation_package_fsm() returns trigger language plpgsql as $$
declare allowed jsonb := '{"received":["accepted","rejected","void"],"accepted":["superseded","void"],"rejected":[],"superseded":[],"void":[]}';
  v_missing text;
begin
  if tg_op = 'INSERT' then
    new.received_by := core.current_sub(); new.received_at := clock_timestamp(); new.reviewed_by := null; new.reviewed_at := null;
    if new.status <> 'received' then raise exception 'a validation package is received first, then reviewed (VAL-04)' using errcode = 'check_violation'; end if;
    return new;
  end if;
  if (new.app_id, new.version, new.gxp_class, new.provider_id, new.package_uri, new.package_sha256, new.contents, new.received_by, new.received_at)
     is distinct from (old.app_id, old.version, old.gxp_class, old.provider_id, old.package_uri, old.package_sha256, old.contents, old.received_by, old.received_at) then
    raise exception 'a received validation package cannot be edited: record a new one (VAL-04)' using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not coalesce((allowed->old.status) ? new.status, false) then
    raise exception 'validation package status % -> % not allowed (VAL-04)', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status in ('accepted', 'rejected') and old.status = 'received' then
    if current_user in ('authenticated', 'app_service') and not core.has_any_role(array['qa_auditor']) then
      raise exception 'a validation package is reviewed by QA (qa_auditor) (VAL-04)' using errcode = 'insufficient_privilege';
    end if;
    if length(btrim(coalesce(new.review_note, ''))) = 0 then
      raise exception 'the review of a validation package needs a note (VAL-04)' using errcode = 'check_violation';
    end if;
    if new.status = 'accepted' and new.gxp_class in ('L2', 'L3') then
      select string_agg(x, ', ') into v_missing
        from unnest(array['URS', 'risk_assessment', 'test_evidence', 'traceability']) x where not x = any(new.contents);
      if v_missing is not null then
        raise exception 'the validation package of an % app must contain %: missing % (VAL-04)', new.gxp_class,
          'URS, risk_assessment, test_evidence, traceability', v_missing using errcode = 'check_violation';
      end if;
    end if;
    new.reviewed_by := core.current_sub(); new.reviewed_at := clock_timestamp();
  elsif new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at then
    raise exception 'review fields are set by the database (VAL-04)' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists fsm on core.app_validation_package;
create trigger fsm before insert or update on core.app_validation_package for each row execute function core.app_validation_package_fsm();

create or replace function core.app_contract_test_stamp() returns trigger language plpgsql as $$
begin
  new.recorded_by := core.current_sub();
  new.executed_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists stamp on core.app_contract_test_run;
create trigger stamp before insert on core.app_contract_test_run for each row execute function core.app_contract_test_stamp();

-- Evidence on the installation itself: which package and which contract test run allowed the activation.
alter table core.app_installation add column if not exists validation_package_id uuid references core.app_validation_package(id);
alter table core.app_installation add column if not exists contract_test_run_id uuid references core.app_contract_test_run(id);

-- Gate status of an app version (for the API and the installation trigger).
create or replace function core.app_validation_gate(p_app text, p_version text, p_class text)
returns table (required boolean, package_id uuid, package_status text, supplier_code text, supplier_status text,
               contract_test_run_id uuid, contract_test_result text, ok boolean, problems text[])
language plpgsql stable security definer set search_path = core, public as $$
#variable_conflict use_column
declare p record; t record; v_problems text[] := '{}'; v_required boolean := p_class in ('L2', 'L3');
begin
  select vp.id, vp.status, sp.code, sp.status as sstatus into p
    from core.app_validation_package vp join core.service_provider sp on sp.id = vp.provider_id
   where vp.app_id = p_app and vp.version = p_version and vp.status in ('accepted', 'received')
   order by (vp.status = 'accepted') desc, vp.received_at desc limit 1;
  select r.id, r.result into t from core.app_contract_test_run r where r.app_id = p_app and r.version = p_version
   order by r.executed_at desc, r.id limit 1;
  if v_required then
    if p.id is null or p.status <> 'accepted' then v_problems := array_append(v_problems, 'no accepted supplier validation package for this version'); end if;
    if p.id is not null and p.sstatus <> 'active' then v_problems := array_append(v_problems, format('supplier %s is %s', p.code, p.sstatus)); end if;
    if t.id is null then v_problems := array_append(v_problems, 'no contract test run for this version');
    elsif t.result <> 'pass' then v_problems := array_append(v_problems, 'the latest contract test run failed'); end if;
  end if;
  return query select v_required, p.id, p.status, p.code, p.sstatus, t.id, t.result, cardinality(v_problems) = 0, v_problems;
end $$;

-- VAL-04 + CMP-08 gate on activation (fires before the lifecycle trigger of 0005, which grants the scopes).
create or replace function core.app_activation_gate() returns trigger language plpgsql security definer set search_path = core, public as $$
declare g record; v_region text;
begin
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then return new; end if;
  select * into g from core.app_validation_gate(new.app_id, new.version, new.gxp_class);
  if g.required and not g.ok then
    raise exception '% app % % cannot be activated: % (VAL-04)', new.gxp_class, new.app_id, new.version, array_to_string(g.problems, '; ')
      using errcode = 'check_violation';
  end if;
  new.validation_package_id := case when g.required then g.package_id end;
  new.contract_test_run_id := case when g.required then g.contract_test_run_id end;
  if new.platform_id is not null then
    select data_region into v_region from core.platform where id = new.platform_id;
    if v_region is not null and not coalesce(new.manifest->'data_residency' ? v_region, false) then
      raise exception 'app % does not keep its data in % (data_residency of the manifest) (CMP-08)', new.app_id, v_region
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists gate_validation on core.app_installation;
create trigger gate_validation before insert or update on core.app_installation for each row execute function core.app_activation_gate();

-- =====================================================================================================================
-- RLS and grants (consistent with 0006: no delete, no grant to anon; apps do not write governance records)
-- =====================================================================================================================
do $$
declare t text;
begin
  foreach t in array array['ctq_factor', 'quality_risk', 'quality_tolerance_limit', 'qtl_observation'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('drop policy if exists scope on core.%I', t);
    execute format('create policy scope on core.%I using (core.can_see_arm(platform_id, arm_id)) with check (core.can_see_arm(platform_id, arm_id))', t);
  end loop;
end $$;
alter table core.platform_provider enable row level security;
drop policy if exists scope on core.platform_provider;
create policy scope on core.platform_provider using (core.can_see_platform(platform_id)) with check (core.can_see_platform(platform_id));

revoke all on core.ctq_factor, core.quality_risk, core.quality_tolerance_limit, core.qtl_observation, core.service_provider,
  core.provider_agreement, core.provider_oversight_activity, core.platform_provider, core.ropa_entry, core.app_validation_package,
  core.app_contract_test_run from public, anon, app_service;
grant select, insert, update on core.ctq_factor, core.quality_risk, core.quality_tolerance_limit, core.service_provider,
  core.provider_agreement, core.provider_oversight_activity, core.platform_provider, core.ropa_entry, core.app_validation_package
  to authenticated;
grant select, insert on core.qtl_observation, core.app_contract_test_run to authenticated;

revoke execute on function core.governance_guard(), core.rbqm_evaluate(uuid), core.arm_decision_timeline(uuid),
  core.register_reidentification(uuid, text, text, text), sac_enclave.reidentify(uuid, text), core.privacy_check(uuid), core.reidentification_key_exposed(),
  core.app_validation_gate(text, text, text), core.app_activation_gate(), core.qtl_observe(), core.provider_allowed(uuid, text, text),
  core.provider_oversight_status(date), core.provider_agreement_gaps(uuid, text[], text[], boolean, date), core.rbqm_metric(uuid, text)
  from public;
grant execute on function core.rbqm_evaluate(uuid), core.arm_decision_timeline(uuid), core.privacy_check(uuid), core.reidentification_key_exposed(),
  core.app_validation_gate(text, text, text), core.provider_allowed(uuid, text, text), core.provider_oversight_status(date),
  core.provider_agreement_gaps(uuid, text[], text[], boolean, date), core.rbqm_metric(uuid, text) to authenticated;
grant execute on function core.register_reidentification(uuid, text, text, text) to authenticated, app_service;
grant execute on function sac_enclave.reidentify(uuid, text) to unblinded;
grant execute on function core.provider_allowed(uuid, text, text) to app_service;
