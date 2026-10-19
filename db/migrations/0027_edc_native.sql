-- TrialOps · 0027 native EDC (module M06b, decision of 6 October 2026): CRF library, site data entry, declarative edit
-- checks, query workflow, visit.completed and the data collection metric.
-- Req: EDC-01 (versioned CRF library linked to the visits of the structured protocol; CDASH-like item OIDs; units and coded
--      values only from versioned codelists, rule 13; approved versions signed and immutable),
--      EDC-03 (site data entry: typed value or missing-data reason ND/NA/UNK; author and server UTC time on every value,
--      rule 11; changes with reason, prior values kept in the audit trail; provenance of app-written values, APP-DT-05;
--      the investigator keeps access to the data of the site, EMA 2023 §4.6),
--      EDC-04 (edit checks declared as rows of the CRF version: required, range, cross-field compare; evaluated by the
--      database at entry, at form completion and in batch; soft checks open queries, hard checks refuse the value),
--      EDC-05 (query state machine open -> answered -> closed / cancelled, answered -> open for a re-query; audited, no
--      physical delete), EDC-11 (no arm anywhere in the EDC), EDC-12 (visit.completed event and the TA3-DATA-COLLECT
--      metric computed from completed visits).
-- Design:
--   * definitions (codelist, codelist_term, visit_definition, crf_form, crf_version, crf_item, crf_edit_check, crf_visit)
--     are platform data maintained by a data manager or a platform admin (trigger guard). A CRF version is a draft until
--     it is approved with an approval signature on that very version (CMP-02), never by one of its authors (IAM-05); from
--     then on the version and all its items, checks and visit links are frozen (new version instead of edit, DM-02).
--     The previous approved version of the form is superseded in the same transaction.
--   * clinical data (subject_visit, crf_entry, item_value, edc_query) is site data: platform, site and subject are taken
--     from the parent record, never from the caller; author and time come from the server. Site staff (site_pi,
--     study_coordinator) enter and correct data; data managers and monitors (cra) open, close and cancel queries; the site
--     answers. Agents never write EDC data and do not read it in v1; apps write values only with the scope
--     edc.data:write on the platform and with provenance (core.stamp_provenance).
--   * reading clinical data needs the platform and site perimeter (RLS) and a clinical-operations role
--     (core.edc_clinical_reader): sponsors (arm_sponsor_lead) do not read subject-level EDC data, since their perimeter is
--     an arm and subject-level data must not be split by arm (rule 5).
--   * edit checks are evaluated by core.edc_evaluate() (security definer, deterministic, same input -> same queries):
--     after every value write (hard check failing -> the write is refused; soft -> one open query per check and entry),
--     at form completion (required checks), and in batch. A check that passes after a data change closes its open
--     queries, with the reason in the audit trail.
--   * blinding (rule 5, EDC-11): no table, view or function here has an arm column or reads core.subject.arm_id; visit
--     definitions and CRFs are platform level (arm-specific eCRFs, EDC-02, need their own blinding design); the
--     visit.completed event carries no arm; the data collection metric is platform level only.
-- Grants: select/insert/update on the new tables to authenticated (RLS on all of them); app_service reads definitions and
-- entries and writes item_value only (guarded by the app scope); select on the view to authenticated and app_service.
-- REVOKE only on the new objects (no default privilege leaks to public/anon); no change to existing grants, tables or
-- policies. No DROP, DELETE or TRUNCATE.
-- Idempotent: it can be run again.

-- =====================================================================================================================
-- helpers
-- =====================================================================================================================
-- Caller through the API (PostgREST or the Platform API) as opposed to the owner (migrations, seed, security definer code).
create or replace function core.edc_api_caller() returns boolean language sql stable as $$
  select current_user in ('authenticated', 'app_service', 'anon')
$$;

-- An app holds a scope on the platform (security definer: app_service cannot read app installations itself).
create or replace function core.edc_app_scope(p_platform uuid, p_scope text) returns boolean
language sql stable security definer set search_path = core, public as $$
  select core.current_actor_type() = 'app' and core.app_has_scope(nullif(core.jwt()->>'app_id', ''), p_platform, p_scope)
$$;

create or replace function core.edc_reader_roles() returns text[] language sql immutable as $$
  select array['platform_admin', 'platform_ops_manager', 'ctm', 'cra', 'site_pi', 'study_coordinator', 'data_manager',
               'safety_physician', 'qa_auditor']
$$;

-- Read access to subject-level EDC data (used by the RLS policies, together with the platform and site perimeter).
create or replace function core.edc_clinical_reader(p_platform uuid) returns boolean language sql stable as $$
  select not core.edc_api_caller()
      or core.has_any_role(core.edc_reader_roles())
      or core.edc_app_scope(p_platform, 'edc.data:read')
      or core.edc_app_scope(p_platform, 'edc.data:write')
$$;

-- Same rule, from the token only, for security definer functions (where current_user is the owner). No claims at all =
-- the owner context (migrations, seed); every API request carries claims.
create or replace function core.edc_claims_allow(p_platform uuid, p_site uuid) returns boolean language sql stable as $$
  select core.jwt() = '{}'::jsonb
      or ((core.claim_uuid_list('platform_ids') is null or p_platform = any(core.claim_uuid_list('platform_ids')))
          and (p_site is null or core.claim_uuid_list('site_scopes') is null or p_site = any(core.claim_uuid_list('site_scopes')))
          and (core.has_any_role(core.edc_reader_roles()) or core.edc_app_scope(p_platform, 'edc.data:read')
               or core.edc_app_scope(p_platform, 'edc.data:write')))
$$;

-- BEFORE INSERT/UPDATE guard of the definition tables: API callers must be a person with one of the listed roles.
create or replace function core.edc_guard() returns trigger language plpgsql as $$
begin
  if core.edc_api_caller() and not core.has_any_role(tg_argv::text[]) then
    raise exception '% is maintained by a person with role % (EDC-01)', tg_table_name, array_to_string(tg_argv, ' or ')
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- Today in UTC (rule 11): clinical dates are checked against the server clock, never the caller's.
create or replace function core.edc_today() returns date language sql stable as $$
  select (clock_timestamp() at time zone 'UTC')::date
$$;

-- =====================================================================================================================
-- EDC-01 · versioned dictionaries (rule 13): codelists and their terms
-- =====================================================================================================================
create table if not exists core.codelist (
  id                 uuid primary key default gen_random_uuid(),
  platform_id        uuid not null references core.platform(id),
  code               text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),            -- e.g. NY, UNIT, VSPOS
  name               text not null check (length(btrim(name)) between 1 and 200),
  dictionary         text not null check (dictionary in ('CDISC-CT', 'UCUM', 'SPONSOR')),
  dictionary_version text not null check (dictionary_version ~ '^[A-Za-z0-9_.-]{1,40}$'), -- e.g. 2026-09-26
  status             text not null default 'draft' check (status in ('draft', 'approved', 'superseded', 'void')),
  created_by         text not null default core.current_sub(),
  created_at         timestamptz not null default clock_timestamp(),
  updated_at         timestamptz not null default clock_timestamp(),
  row_version        int not null default 1,
  unique (platform_id, code, dictionary_version)
);
comment on table core.codelist is 'Versioned controlled terminology adopted by a platform (rule 13, EDC-01): CDISC CT, UCUM units, sponsor lists';

create table if not exists core.codelist_term (
  id               uuid primary key default gen_random_uuid(),
  platform_id      uuid not null references core.platform(id),
  codelist_id      uuid not null references core.codelist(id),
  submission_value text not null check (submission_value ~ '^[A-Za-z0-9][A-Za-z0-9_.+/ %-]{0,59}$'),
  decode           text not null check (length(btrim(decode)) between 1 and 200),
  nci_code         text check (nci_code ~ '^C[0-9]{1,8}$'),
  ordinal          int not null default 0,
  created_by       text not null default core.current_sub(),
  created_at       timestamptz not null default clock_timestamp(),
  unique (codelist_id, submission_value)
);
comment on table core.codelist_term is 'Terms of a codelist version (rule 13); append-only, added only while the codelist is a draft';

-- =====================================================================================================================
-- EDC-01 · visits of the structured protocol and the CRF library
-- =====================================================================================================================
create table if not exists core.visit_definition (
  id                 uuid primary key default gen_random_uuid(),
  platform_id        uuid not null references core.platform(id),
  master_protocol_version_id uuid not null references core.master_protocol_version(id),
  code               text not null check (code ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'),       -- e.g. SCR, BL, W4
  name               text not null check (length(btrim(name)) between 1 and 200),
  ordinal            int not null default 0,
  planned_day        int,
  window_before_days int not null default 0 check (window_before_days >= 0),
  window_after_days  int not null default 0 check (window_after_days >= 0),
  usdm_encounter_id  text check (length(usdm_encounter_id) <= 200),                  -- the encounter of the USDM protocol
  status             text not null default 'active' check (status in ('active', 'retired', 'void')),
  created_by         text not null default core.current_sub(),
  created_at         timestamptz not null default clock_timestamp(),
  updated_at         timestamptz not null default clock_timestamp(),
  row_version        int not null default 1,
  unique (master_protocol_version_id, code)
);
comment on table core.visit_definition is 'Visits of the platform schedule from the Master Protocol (EDC-01); platform level, never per arm (rule 5)';

create table if not exists core.crf_form (
  id           uuid primary key default gen_random_uuid(),
  platform_id  uuid not null references core.platform(id),
  oid          text not null check (oid ~ '^F\.[A-Z0-9_]{1,30}$'),                     -- ODM FormOID, e.g. F.VS
  name         text not null check (length(btrim(name)) between 1 and 200),
  cdash_domain text check (cdash_domain ~ '^[A-Z]{2}$'),                                -- e.g. VS, IE
  status       text not null default 'active' check (status in ('active', 'retired', 'void')),
  created_by   text not null default core.current_sub(),
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  row_version  int not null default 1,
  unique (platform_id, oid)
);
comment on table core.crf_form is 'A CRF of the library (EDC-01); its content lives in versions';

create table if not exists core.crf_version (
  id                    uuid primary key default gen_random_uuid(),
  platform_id           uuid not null references core.platform(id),
  form_id               uuid not null references core.crf_form(id),
  version_no            int not null check (version_no >= 1),
  status                text not null default 'draft' check (status in ('draft', 'approved', 'superseded', 'void')),
  approved_signature_id uuid references core.signature(id),
  approved_at           timestamptz,
  created_by            text not null default core.current_sub(),
  created_at            timestamptz not null default clock_timestamp(),
  updated_at            timestamptz not null default clock_timestamp(),
  row_version           int not null default 1,
  unique (form_id, version_no)
);
comment on table core.crf_version is 'Version of a CRF (EDC-01): draft, then approved with a signature and frozen, then superseded';

create table if not exists core.crf_item (
  id             uuid primary key default gen_random_uuid(),
  platform_id    uuid not null references core.platform(id),
  crf_version_id uuid not null references core.crf_version(id),
  oid            text not null check (oid ~ '^I\.[A-Z0-9_.]{1,40}$'),                   -- ODM ItemOID, e.g. I.VS.SYSBP
  cdash_variable text not null check (cdash_variable ~ '^[A-Z][A-Z0-9]{0,7}$'),          -- e.g. SYSBP
  label          text not null check (length(btrim(label)) between 1 and 200),
  data_type      text not null check (data_type in ('integer', 'decimal', 'text', 'date', 'coded')),
  codelist_id    uuid references core.codelist(id),
  unit_term_id   uuid references core.codelist_term(id),
  required       boolean not null default false,
  ordinal        int not null default 0,
  status         text not null default 'active' check (status in ('active', 'void')),
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  row_version    int not null default 1,
  unique (crf_version_id, oid),
  check ((data_type = 'coded') = (codelist_id is not null))
);
comment on table core.crf_item is 'Item of a CRF version (EDC-01): CDASH variable, type, unit and codelist from versioned dictionaries (rule 13)';

create table if not exists core.crf_edit_check (
  id             uuid primary key default gen_random_uuid(),
  platform_id    uuid not null references core.platform(id),
  crf_version_id uuid not null references core.crf_version(id),
  code           text not null check (code ~ '^EC\.[A-Z0-9_.]{1,40}$'),
  kind           text not null check (kind in ('required', 'range', 'compare')),
  item_oid       text not null check (item_oid ~ '^I\.[A-Z0-9_.]{1,40}$'),
  operator       text check (operator in ('<', '<=', '>', '>=', '=', '<>')),
  other_item_oid text check (other_item_oid ~ '^I\.[A-Z0-9_.]{1,40}$'),
  min_value      numeric,
  max_value      numeric,
  severity       text not null default 'soft' check (severity in ('soft', 'hard')),
  message        text not null check (length(btrim(message)) between 1 and 500),
  status         text not null default 'active' check (status in ('active', 'void')),
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  row_version    int not null default 1,
  unique (crf_version_id, code),
  check (kind <> 'range' or ((min_value is not null or max_value is not null) and operator is null and other_item_oid is null)),
  check (kind <> 'range' or min_value is null or max_value is null or min_value <= max_value),
  check (kind <> 'compare' or (operator is not null and other_item_oid is not null and min_value is null and max_value is null)),
  check (kind <> 'required' or (operator is null and other_item_oid is null and min_value is null and max_value is null))
);
comment on table core.crf_edit_check is 'Declarative edit check of a CRF version (EDC-04): data, not code; evaluated by core.edc_evaluate()';

create table if not exists core.crf_visit (
  id                  uuid primary key default gen_random_uuid(),
  platform_id         uuid not null references core.platform(id),
  crf_version_id      uuid not null references core.crf_version(id),
  visit_definition_id uuid not null references core.visit_definition(id),
  status              text not null default 'active' check (status in ('active', 'void')),
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  row_version         int not null default 1,
  unique (crf_version_id, visit_definition_id)
);
comment on table core.crf_visit is 'Visits at which a CRF version is collected (EDC-01); part of the approved version';

-- =====================================================================================================================
-- EDC-03 / EDC-05 · clinical data of the sites
-- =====================================================================================================================
create table if not exists core.subject_visit (
  id                  uuid primary key default gen_random_uuid(),
  platform_id         uuid not null references core.platform(id),
  site_id             uuid not null references core.site(id),
  subject_id          uuid not null references core.subject(id),
  visit_definition_id uuid not null references core.visit_definition(id),
  visit_date          date not null,                                   -- clinical date of the visit, entered by the site
  status              text not null default 'in_progress' check (status in ('in_progress', 'completed', 'void')),
  completed_at        timestamptz,
  completed_by        text,
  created_by          text not null default core.current_sub(),
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  row_version         int not null default 1,
  check ((status = 'completed') = (completed_at is not null))
);
comment on table core.subject_visit is 'A visit of a subject (EDC-03, EDC-12); completion emits visit.completed; no arm (rule 5)';
create unique index if not exists subject_visit_once_idx on core.subject_visit (subject_id, visit_definition_id) where status <> 'void';
create index if not exists subject_visit_site_idx on core.subject_visit (platform_id, site_id);

create table if not exists core.crf_entry (
  id               uuid primary key default gen_random_uuid(),
  platform_id      uuid not null references core.platform(id),
  site_id          uuid not null references core.site(id),
  subject_id       uuid not null references core.subject(id),
  subject_visit_id uuid not null references core.subject_visit(id),
  crf_form_id      uuid not null references core.crf_form(id),
  crf_version_id   uuid not null references core.crf_version(id),   -- the data stays bound to the version it was entered with
  status           text not null default 'in_progress' check (status in ('in_progress', 'complete', 'void')),
  completed_at     timestamptz,
  completed_by     text,
  created_by       text not null default core.current_sub(),
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  row_version      int not null default 1,
  check ((status = 'complete') = (completed_at is not null))
);
comment on table core.crf_entry is 'A CRF filled in for a subject visit (EDC-03), bound to the CRF version used';
create unique index if not exists crf_entry_once_idx on core.crf_entry (subject_visit_id, crf_form_id) where status <> 'void';

create table if not exists core.item_value (
  id             uuid primary key default gen_random_uuid(),
  platform_id    uuid not null references core.platform(id),
  site_id        uuid not null references core.site(id),
  subject_id     uuid not null references core.subject(id),
  crf_entry_id   uuid not null references core.crf_entry(id),
  crf_item_id    uuid not null references core.crf_item(id),
  item_oid       text not null,
  value          text check (length(value) <= 2000),
  value_num      numeric,
  value_date     date,
  missing_reason text check (missing_reason in ('ND', 'NA', 'UNK')),    -- not done, not applicable, unknown
  source         text not null default 'site_entry' check (source in ('site_entry', 'app', 'system')),
  entered_by     text not null default core.current_sub(),
  entered_at     timestamptz not null default clock_timestamp(),
  status         text not null default 'active' check (status in ('active', 'void')),
  source_app        text check (length(source_app) <= 200),
  source_record_id  text check (length(source_record_id) <= 200),
  source_version    text check (length(source_version) <= 200),
  transformation_id text check (length(transformation_id) <= 200),
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  row_version    int not null default 1,
  unique (crf_entry_id, crf_item_id),
  check ((value is null) <> (missing_reason is null))
);
comment on table core.item_value is 'Current value of an item (EDC-03): author and server time of the last change; prior values with reason in the audit trail';

create table if not exists core.edc_query (
  id             uuid primary key default gen_random_uuid(),
  platform_id    uuid not null references core.platform(id),
  site_id        uuid not null references core.site(id),
  subject_id     uuid not null references core.subject(id),
  crf_entry_id   uuid not null references core.crf_entry(id),
  item_value_id  uuid references core.item_value(id),
  crf_item_id    uuid references core.crf_item(id),
  edit_check_id  uuid references core.crf_edit_check(id),
  origin         text not null check (origin in ('edit_check', 'manual')),
  status         text not null default 'open' check (status in ('open', 'answered', 'closed', 'cancelled')),
  question       text not null check (length(btrim(question)) between 1 and 2000),
  answer         text check (length(answer) <= 2000),
  close_reason   text check (length(close_reason) <= 2000),
  opened_by      text not null default core.current_sub(),
  opened_at      timestamptz not null default clock_timestamp(),
  answered_by    text,
  answered_at    timestamptz,
  closed_by      text,
  closed_at      timestamptz,
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  row_version    int not null default 1,
  check ((origin = 'edit_check') = (edit_check_id is not null))
);
comment on table core.edc_query is 'Data query (EDC-05): state machine open -> answered -> closed / cancelled; times for metrics; audited';
create index if not exists edc_query_status_idx on core.edc_query (platform_id, status);
create index if not exists edc_query_entry_idx on core.edc_query (crf_entry_id, status);

-- standard triggers: touch, audit (reason on update, DM-03), no physical delete
do $$
declare t text;
begin
  foreach t in array array['codelist', 'visit_definition', 'crf_form', 'crf_version', 'crf_item', 'crf_edit_check', 'crf_visit',
                           'subject_visit', 'crf_entry', 'item_value', 'edc_query'] loop
    if not exists (select 1 from pg_trigger where tgrelid = format('core.%I', t)::regclass and tgname = 'audit') then
      perform core.attach_std(format('core.%I', t)::regclass, 'gxp');
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'core.codelist_term'::regclass and tgname = 'audit') then
    create trigger audit after insert on core.codelist_term for each row execute function core.audit_row('gxp');
    create trigger immutable before update or delete on core.codelist_term for each row execute function core.audit_immutable();
    create trigger immutable_truncate before truncate on core.codelist_term execute function core.audit_immutable();
  end if;
end $$;

-- =====================================================================================================================
-- integrity of the definitions
-- =====================================================================================================================
create or replace function core.codelist_integrity() returns trigger language plpgsql as $$
declare allowed jsonb := '{"draft":["approved","void"],"approved":["superseded"],"superseded":[],"void":[]}';
begin
  if tg_op = 'INSERT' then
    new.status := 'draft'; new.created_by := core.current_sub(); new.created_at := clock_timestamp();
    return new;
  end if;
  if (new.platform_id, new.code, new.dictionary, new.dictionary_version, new.created_by, new.created_at)
     is distinct from (old.platform_id, old.code, old.dictionary, old.dictionary_version, old.created_by, old.created_at) then
    raise exception 'platform, code, dictionary and version of a codelist cannot change (rule 13)' using errcode = 'insufficient_privilege';
  end if;
  if old.status <> 'draft' and new.name is distinct from old.name then
    raise exception 'an approved codelist is immutable: adopt a new dictionary version (rule 13)' using errcode = 'check_violation';
  end if;
  if new.status <> old.status then
    if not coalesce((allowed->old.status) ? new.status, false) then
      raise exception 'codelist status % -> % not allowed (rule 13)', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'approved' then
      if not exists (select 1 from core.codelist_term t where t.codelist_id = new.id) then
        raise exception 'a codelist needs at least one term to be approved (rule 13)' using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end $$;

create or replace function core.codelist_term_integrity() returns trigger language plpgsql as $$
declare l record;
begin
  select platform_id, status into l from core.codelist where id = new.codelist_id;
  if l.platform_id is null then raise exception 'codelist not found' using errcode = 'foreign_key_violation'; end if;
  if l.status <> 'draft' then
    raise exception 'terms are added only to a draft codelist; an approved codelist is immutable (rule 13)' using errcode = 'check_violation';
  end if;
  new.platform_id := l.platform_id; new.created_by := core.current_sub(); new.created_at := clock_timestamp();
  return new;
end $$;

create or replace function core.visit_definition_integrity() returns trigger language plpgsql as $$
declare v_platform uuid;
begin
  if tg_op = 'INSERT' then
    select platform_id into v_platform from core.master_protocol_version where id = new.master_protocol_version_id;
    if v_platform is distinct from new.platform_id then
      raise exception 'the protocol version belongs to another platform (EDC-01)' using errcode = 'check_violation';
    end if;
    new.created_by := core.current_sub(); new.created_at := clock_timestamp();
    if new.status <> 'active' then raise exception 'a visit definition starts active (EDC-01)' using errcode = 'check_violation'; end if;
    return new;
  end if;
  if (new.platform_id, new.master_protocol_version_id, new.code, new.created_by, new.created_at)
     is distinct from (old.platform_id, old.master_protocol_version_id, old.code, old.created_by, old.created_at) then
    raise exception 'platform, protocol version and code of a visit definition cannot change (EDC-01)' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'void' then raise exception 'a void visit definition is closed (DM-03)' using errcode = 'check_violation'; end if;
  return new;
end $$;

create or replace function core.crf_form_integrity() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := core.current_sub(); new.created_at := clock_timestamp();
    if new.status <> 'active' then raise exception 'a CRF starts active (EDC-01)' using errcode = 'check_violation'; end if;
    return new;
  end if;
  if (new.platform_id, new.oid, new.created_by, new.created_at) is distinct from (old.platform_id, old.oid, old.created_by, old.created_at) then
    raise exception 'platform and OID of a CRF cannot change (EDC-01)' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'void' then raise exception 'a void CRF is closed (DM-03)' using errcode = 'check_violation'; end if;
  return new;
end $$;

-- Version state machine. Security definer: reads the signature and the audit ledger for separation of duties.
create or replace function core.crf_version_integrity() returns trigger language plpgsql security definer set search_path = core, public as $$
declare
  allowed jsonb := '{"draft":["approved","void"],"approved":["superseded"],"superseded":[],"void":[]}';
  f record; s core.signature%rowtype; v_bad text;
begin
  if tg_op = 'INSERT' then
    select platform_id, status into f from core.crf_form where id = new.form_id;
    if f.platform_id is null or f.status <> 'active' then
      raise exception 'versions are created only for an active CRF (EDC-01)' using errcode = 'check_violation';
    end if;
    new.platform_id := f.platform_id;
    if new.version_no is null then
      select coalesce(max(version_no), 0) + 1 into new.version_no from core.crf_version where form_id = new.form_id;
    end if;
    new.status := 'draft'; new.approved_signature_id := null; new.approved_at := null;
    new.created_by := core.current_sub(); new.created_at := clock_timestamp();
    return new;
  end if;
  if (new.platform_id, new.form_id, new.version_no, new.created_by, new.created_at)
     is distinct from (old.platform_id, old.form_id, old.version_no, old.created_by, old.created_at) then
    raise exception 'form, number and author of a CRF version cannot change (EDC-01)' using errcode = 'insufficient_privilege';
  end if;
  if new.status = old.status then
    if new.approved_signature_id is distinct from old.approved_signature_id or new.approved_at is distinct from old.approved_at then
      raise exception 'the approval of a CRF version is set only by its approval (CMP-02)' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if not coalesce((allowed->old.status) ? new.status, false) then
    raise exception 'CRF version status % -> % not allowed: approved versions are immutable, create a new version (EDC-01, DM-02)',
      old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status = 'approved' then
    select * into s from core.signature where id = new.approved_signature_id;
    if s.id is null or s.target_table <> 'crf_version' or s.target_id <> new.id or s.meaning <> 'approval' then
      raise exception 'approving a CRF version requires an approval signature on that version (CMP-02)' using errcode = 'check_violation';
    end if;
    if exists (select 1 from core.audit_event a where a.actor_sub = s.signer_sub and a.action in ('INSERT', 'UPDATE')
                 and ((a.table_name = 'crf_version' and a.record_id = new.id)
                   or (a.table_name in ('crf_item', 'crf_edit_check', 'crf_visit') and a.new_row->>'crf_version_id' = new.id::text))) then
      raise exception 'separation of duties: an author of the CRF version cannot approve it (IAM-05)' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from core.crf_item i where i.crf_version_id = new.id and i.status = 'active') then
      raise exception 'a CRF version needs at least one item to be approved (EDC-01)' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from core.crf_visit l join core.visit_definition d on d.id = l.visit_definition_id
                    where l.crf_version_id = new.id and l.status = 'active' and d.status = 'active') then
      raise exception 'a CRF version must be linked to at least one active protocol visit to be approved (EDC-01)' using errcode = 'check_violation';
    end if;
    select string_agg(c.code, ', ') into v_bad from core.crf_edit_check c
     where c.crf_version_id = new.id and c.status = 'active'
       and (not exists (select 1 from core.crf_item i where i.crf_version_id = new.id and i.status = 'active' and i.oid = c.item_oid)
         or (c.other_item_oid is not null and not exists (select 1 from core.crf_item i where i.crf_version_id = new.id
               and i.status = 'active' and i.oid = c.other_item_oid)));
    if v_bad is not null then
      raise exception 'edit checks refer to items that are not in the version: % (EDC-04)', v_bad using errcode = 'check_violation';
    end if;
    new.approved_at := clock_timestamp();
    -- one approved version per form: the previous one is superseded in the same transaction
    update core.crf_version set status = 'superseded' where form_id = new.form_id and status = 'approved' and id <> new.id;
    perform core.emit('edc.crf.version.approved', 'crf_version/' || new.id, new.platform_id, null,
      jsonb_build_object('form_id', new.form_id, 'version_no', new.version_no, 'signature_id', s.id));
  elsif new.approved_signature_id is distinct from old.approved_signature_id or new.approved_at is distinct from old.approved_at then
    raise exception 'the approval of a CRF version is set only by its approval (CMP-02)' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- Items, checks and visit links belong to a draft version; once approved they are frozen (DM-02).
create or replace function core.crf_definition_integrity() returns trigger language plpgsql as $$
declare v record; it record; ot record;
begin
  select id, platform_id, status into v from core.crf_version where id = new.crf_version_id;
  if v.id is null then raise exception 'CRF version not found' using errcode = 'foreign_key_violation'; end if;
  if tg_op = 'UPDATE' and new.crf_version_id is distinct from old.crf_version_id then
    raise exception '% cannot move to another CRF version (EDC-01)', tg_table_name using errcode = 'insufficient_privilege';
  end if;
  if v.status <> 'draft' then
    raise exception 'CRF version is %: approved versions are immutable, create a new version (EDC-01, DM-02)', v.status
      using errcode = 'check_violation';
  end if;
  new.platform_id := v.platform_id;
  if tg_table_name = 'crf_item' then
    if tg_op = 'UPDATE' and new.oid is distinct from old.oid then
      raise exception 'the OID of an item cannot change (EDC-01)' using errcode = 'insufficient_privilege';
    end if;
    if new.codelist_id is not null and not exists (select 1 from core.codelist c where c.id = new.codelist_id
         and c.platform_id = v.platform_id and c.status = 'approved') then
      raise exception 'a coded item needs an approved codelist of the platform (rule 13)' using errcode = 'check_violation';
    end if;
    if new.unit_term_id is not null then
      if new.data_type not in ('integer', 'decimal') then
        raise exception 'only numeric items have a unit (EDC-01)' using errcode = 'check_violation';
      end if;
      if not exists (select 1 from core.codelist_term t join core.codelist c on c.id = t.codelist_id where t.id = new.unit_term_id
                       and c.code = 'UNIT' and c.platform_id = v.platform_id and c.status = 'approved') then
        raise exception 'the unit must be a term of an approved UNIT codelist (rule 13)' using errcode = 'check_violation';
      end if;
    end if;
  elsif tg_table_name = 'crf_edit_check' then
    select data_type into it from core.crf_item where crf_version_id = new.crf_version_id and oid = new.item_oid and status = 'active';
    if it.data_type is null then
      raise exception 'edit check % refers to item % that is not in the version (EDC-04)', new.code, new.item_oid using errcode = 'check_violation';
    end if;
    if new.kind in ('range', 'compare') and it.data_type not in ('integer', 'decimal', 'date') then
      raise exception '% checks apply to numeric or date items (EDC-04)', new.kind using errcode = 'check_violation';
    end if;
    if new.kind = 'range' and it.data_type = 'date' then
      raise exception 'range checks apply to numeric items; compare dates with a compare check (EDC-04)' using errcode = 'check_violation';
    end if;
    if new.kind = 'compare' then
      select data_type into ot from core.crf_item where crf_version_id = new.crf_version_id and oid = new.other_item_oid and status = 'active';
      if ot.data_type is null then
        raise exception 'edit check % refers to item % that is not in the version (EDC-04)', new.code, new.other_item_oid using errcode = 'check_violation';
      end if;
      if (it.data_type = 'date') <> (ot.data_type = 'date') or ot.data_type not in ('integer', 'decimal', 'date') then
        raise exception 'compare checks need two numeric or two date items (EDC-04)' using errcode = 'check_violation';
      end if;
    end if;
  elsif tg_table_name = 'crf_visit' then
    if not exists (select 1 from core.visit_definition d where d.id = new.visit_definition_id and d.platform_id = v.platform_id and d.status = 'active') then
      raise exception 'the visit belongs to another platform or is not active (EDC-01)' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- =====================================================================================================================
-- EDC-04 · deterministic evaluation of the declared checks
-- =====================================================================================================================
-- true = passes, false = fails, null = not evaluable (a value is missing or recorded as ND/NA/UNK).
create or replace function core.edc_check_passes(p_check core.crf_edit_check, p_entry uuid) returns boolean
language plpgsql stable security definer set search_path = core, public as $$
declare a core.item_value; b core.item_value; x numeric; y numeric;
begin
  select * into a from core.item_value where crf_entry_id = p_entry and item_oid = p_check.item_oid and status = 'active';
  if p_check.kind = 'required' then return a.id is not null; end if;      -- a value or an explicit missing-data reason
  x := coalesce(a.value_num, (a.value_date - date '1970-01-01')::numeric);
  if x is null then return null; end if;
  if p_check.kind = 'range' then
    return (p_check.min_value is null or x >= p_check.min_value) and (p_check.max_value is null or x <= p_check.max_value);
  end if;
  select * into b from core.item_value where crf_entry_id = p_entry and item_oid = p_check.other_item_oid and status = 'active';
  y := coalesce(b.value_num, (b.value_date - date '1970-01-01')::numeric);
  if y is null then return null; end if;
  return case p_check.operator when '<' then x < y when '<=' then x <= y when '>' then x > y when '>=' then x >= y
                               when '=' then x = y when '<>' then x <> y end;
end $$;

-- Evaluates the active checks of the entry's CRF version. p_mode:
--   'value'    after a value write (only the checks that involve p_item_oid; required checks only close their queries);
--   'complete' at form completion (all checks; a failing hard required check refuses the completion);
--   'batch'    review run (all checks; required checks only on complete forms; hard failures open queries).
-- A failing soft check opens one query per check and entry (never a duplicate); a passing check closes its open queries.
-- Returns the number of queries opened.
create or replace function core.edc_evaluate(p_entry uuid, p_mode text, p_item_oid text default null) returns int
language plpgsql security definer set search_path = core, public as $$
declare
  e core.crf_entry; ck core.crf_edit_check; v_res boolean; v_opened int := 0;
  v_prev text := coalesce(current_setting('trialops.change_reason', true), '');
begin
  if p_mode not in ('value', 'complete', 'batch') then
    raise exception 'unknown evaluation mode % (EDC-04)', p_mode using errcode = 'check_violation';
  end if;
  select * into e from core.crf_entry where id = p_entry;
  if e.id is null or e.status = 'void' then return 0; end if;
  if not core.edc_claims_allow(e.platform_id, e.site_id) then
    raise exception 'form entry outside your perimeter (IAM-02)' using errcode = 'insufficient_privilege';
  end if;
  for ck in select * from core.crf_edit_check c where c.crf_version_id = e.crf_version_id and c.status = 'active'
              and (p_item_oid is null or c.item_oid = p_item_oid or c.other_item_oid = p_item_oid) order by c.code loop
    if ck.kind = 'required' and p_mode = 'batch' and e.status <> 'complete' then continue; end if;
    v_res := core.edc_check_passes(ck, p_entry);
    if v_res is false then
      if ck.kind = 'required' and p_mode = 'value' then continue; end if;
      if ck.severity = 'hard' and p_mode <> 'batch' then
        raise exception 'hard edit check % failed: % (EDC-04)', ck.code, ck.message using errcode = 'check_violation';
      end if;
      if not exists (select 1 from core.edc_query q where q.crf_entry_id = p_entry and q.edit_check_id = ck.id
                       and q.status in ('open', 'answered')) then
        insert into core.edc_query(platform_id, site_id, subject_id, crf_entry_id, item_value_id, crf_item_id, edit_check_id, origin, question)
        select e.platform_id, e.site_id, e.subject_id, p_entry,
               (select v.id from core.item_value v where v.crf_entry_id = p_entry and v.item_oid = ck.item_oid and v.status = 'active'),
               (select i.id from core.crf_item i where i.crf_version_id = e.crf_version_id and i.oid = ck.item_oid),
               ck.id, 'edit_check', ck.message;
        v_opened := v_opened + 1;
      end if;
    elsif exists (select 1 from core.edc_query q where q.crf_entry_id = p_entry and q.edit_check_id = ck.id and q.status in ('open', 'answered')) then
      perform set_config('trialops.change_reason', format('Edit check %s passes after the data change', ck.code), true);
      update core.edc_query set status = 'closed', close_reason = format('Resolved by data change: edit check %s passes', ck.code)
       where crf_entry_id = p_entry and edit_check_id = ck.id and status in ('open', 'answered');
      perform set_config('trialops.change_reason', v_prev, true);
    end if;
  end loop;
  return v_opened;
end $$;

-- Batch run on one form by a data manager, a monitor or the site (EDC-04 "in batch").
create or replace function core.edc_run_checks(p_entry uuid) returns int language plpgsql as $$
declare e record;
begin
  select id, status into e from core.crf_entry where id = p_entry;        -- RLS: the caller must see the entry
  if e.id is null then raise exception 'form entry not found' using errcode = 'no_data_found'; end if;
  if core.edc_api_caller() and not core.has_any_role(array['data_manager', 'cra', 'site_pi', 'study_coordinator']) then
    raise exception 'edit checks are run by a data manager, a monitor or the site (EDC-04)' using errcode = 'insufficient_privilege';
  end if;
  return core.edc_evaluate(p_entry, 'batch', null);
end $$;

-- =====================================================================================================================
-- EDC-03 · subject visits, form entries and values
-- =====================================================================================================================
create or replace function core.edc_site_staff() returns boolean language sql stable as $$
  select not core.edc_api_caller() or core.has_any_role(array['site_pi', 'study_coordinator'])
$$;

create or replace function core.subject_visit_integrity() returns trigger language plpgsql as $$
declare
  s record; d record; v_missing text;
  allowed jsonb := '{"in_progress":["completed","void"],"completed":["in_progress","void"],"void":[]}';
begin
  if not core.edc_site_staff() then
    raise exception 'visits are recorded by the site (site_pi, study_coordinator) (EDC-03)' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    select platform_id, site_id, status into s from core.subject where id = new.subject_id;
    if s.platform_id is null then raise exception 'subject not found (EDC-03)' using errcode = 'foreign_key_violation'; end if;
    if s.status in ('identified', 'prescreened', 'prescreen_failed', 'void') then
      raise exception 'visits are recorded for consented subjects, this one is % (EDC-03)', s.status using errcode = 'check_violation';
    end if;
    select platform_id, status into d from core.visit_definition where id = new.visit_definition_id;
    if d.platform_id is distinct from s.platform_id or d.status <> 'active' then
      raise exception 'the visit definition belongs to another platform or is not active (EDC-01)' using errcode = 'check_violation';
    end if;
    new.platform_id := s.platform_id; new.site_id := s.site_id;
    new.status := 'in_progress'; new.completed_at := null; new.completed_by := null;
    new.created_by := core.current_sub(); new.created_at := clock_timestamp();
    if new.visit_date > core.edc_today() then
      raise exception 'the visit date cannot be in the future (UTC) (EDC-03)' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (new.platform_id, new.site_id, new.subject_id, new.visit_definition_id, new.created_by, new.created_at)
     is distinct from (old.platform_id, old.site_id, old.subject_id, old.visit_definition_id, old.created_by, old.created_at) then
    raise exception 'subject and visit of a subject visit cannot change (EDC-03)' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'void' then raise exception 'a void visit is closed (DM-03)' using errcode = 'check_violation'; end if;
  if new.visit_date > core.edc_today() then
    raise exception 'the visit date cannot be in the future (UTC) (EDC-03)' using errcode = 'check_violation';
  end if;
  if new.status = old.status then
    new.completed_at := old.completed_at; new.completed_by := old.completed_by;
    return new;
  end if;
  if not coalesce((allowed->old.status) ? new.status, false) then
    raise exception 'visit status % -> % not allowed (EDC-03)', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status = 'completed' then
    -- every CRF scheduled at this visit (current approved version) has a complete entry
    select string_agg(f.oid, ', ' order by f.oid) into v_missing from core.crf_form f
     where f.platform_id = new.platform_id and f.status = 'active'
       and exists (select 1 from core.crf_version v join core.crf_visit l on l.crf_version_id = v.id and l.status = 'active'
                    where v.form_id = f.id and v.status = 'approved' and l.visit_definition_id = new.visit_definition_id)
       and not exists (select 1 from core.crf_entry e where e.subject_visit_id = new.id and e.crf_form_id = f.id and e.status = 'complete');
    if v_missing is not null then
      raise exception 'the visit cannot be completed: forms not complete: % (EDC-03)', v_missing using errcode = 'check_violation';
    end if;
    new.completed_at := clock_timestamp(); new.completed_by := core.current_sub();
    select code into d from core.visit_definition where id = new.visit_definition_id;
    -- EDC-12: data available for the visit. The event never carries the allocation (rule 5).
    perform core.emit('visit.completed', 'subject_visit/' || new.id, new.platform_id, null,
      jsonb_build_object('site_id', new.site_id, 'subject_id', new.subject_id, 'visit_definition_id', new.visit_definition_id,
        'visit_code', d.code, 'visit_date', new.visit_date, 'completed_at', new.completed_at,
        'days_to_data', round((extract(epoch from new.completed_at - (new.visit_date::timestamp at time zone 'UTC')) / 86400.0)::numeric, 2)));
  else
    new.completed_at := null; new.completed_by := null;
  end if;
  return new;
end $$;

create or replace function core.crf_entry_integrity() returns trigger language plpgsql as $$
declare
  sv record; v record;
  allowed jsonb := '{"in_progress":["complete","void"],"complete":["in_progress","void"],"void":[]}';
begin
  if not core.edc_site_staff() then
    raise exception 'forms are filled in by the site (site_pi, study_coordinator) (EDC-03)' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    select platform_id, site_id, subject_id, visit_definition_id, status into sv from core.subject_visit where id = new.subject_visit_id;
    if sv.platform_id is null then raise exception 'subject visit not found (EDC-03)' using errcode = 'foreign_key_violation'; end if;
    if sv.status <> 'in_progress' then
      raise exception 'forms are started on a visit in progress, this one is % (EDC-03)', sv.status using errcode = 'check_violation';
    end if;
    if new.crf_version_id is null then
      select id into new.crf_version_id from core.crf_version where form_id = new.crf_form_id and status = 'approved';
    end if;
    select cv.id, cv.form_id, cv.status into v from core.crf_version cv where cv.id = new.crf_version_id;
    if v.id is null or v.status <> 'approved' then
      raise exception 'data are entered only with an approved CRF version (EDC-01)' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from core.crf_visit l where l.crf_version_id = v.id and l.visit_definition_id = sv.visit_definition_id and l.status = 'active') then
      raise exception 'this CRF is not scheduled at this visit (EDC-01)' using errcode = 'check_violation';
    end if;
    new.crf_form_id := v.form_id;
    new.platform_id := sv.platform_id; new.site_id := sv.site_id; new.subject_id := sv.subject_id;
    new.status := 'in_progress'; new.completed_at := null; new.completed_by := null;
    new.created_by := core.current_sub(); new.created_at := clock_timestamp();
    return new;
  end if;
  if (new.platform_id, new.site_id, new.subject_id, new.subject_visit_id, new.crf_form_id, new.crf_version_id, new.created_by, new.created_at)
     is distinct from (old.platform_id, old.site_id, old.subject_id, old.subject_visit_id, old.crf_form_id, old.crf_version_id, old.created_by, old.created_at) then
    raise exception 'visit, CRF and version of a form entry cannot change (EDC-03)' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'void' then raise exception 'a void form entry is closed (DM-03)' using errcode = 'check_violation'; end if;
  if new.status = old.status then
    new.completed_at := old.completed_at; new.completed_by := old.completed_by;
    return new;
  end if;
  if not coalesce((allowed->old.status) ? new.status, false) then
    raise exception 'form entry status % -> % not allowed (EDC-03)', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status = 'complete' then
    perform core.edc_evaluate(new.id, 'complete', null);      -- EDC-04: required checks at completion
    new.completed_at := clock_timestamp(); new.completed_by := core.current_sub();
  else
    new.completed_at := null; new.completed_by := null;
  end if;
  return new;
end $$;

create or replace function core.item_value_integrity() returns trigger language plpgsql as $$
declare e record; it record; v_txt text;
begin
  if tg_op = 'UPDATE' then
    if (new.platform_id, new.site_id, new.subject_id, new.crf_entry_id, new.crf_item_id, new.item_oid)
       is distinct from (old.platform_id, old.site_id, old.subject_id, old.crf_entry_id, old.crf_item_id, old.item_oid) then
      raise exception 'entry and item of a value cannot change (EDC-03)' using errcode = 'insufficient_privilege';
    end if;
    if old.status = 'void' then raise exception 'a void value is closed (DM-03)' using errcode = 'check_violation'; end if;
  end if;
  select en.platform_id, en.site_id, en.subject_id, en.crf_version_id, en.status, sv.status as visit_status into e
    from core.crf_entry en join core.subject_visit sv on sv.id = en.subject_visit_id where en.id = new.crf_entry_id;
  if e.platform_id is null then raise exception 'form entry not found (EDC-03)' using errcode = 'foreign_key_violation'; end if;
  -- who may write: site staff, or an app with the write scope on the platform (with provenance, APP-DT-05)
  if current_user = 'app_service' then
    if not core.edc_app_scope(e.platform_id, 'edc.data:write') then
      raise exception 'the app needs the scope edc.data:write on this platform (EDC-03)' using errcode = 'insufficient_privilege';
    end if;
  elsif not core.edc_site_staff() then
    raise exception 'data are entered and corrected by the site (site_pi, study_coordinator) (EDC-03, EMA investigator control)'
      using errcode = 'insufficient_privilege';
  end if;
  if e.status = 'void' or e.visit_status = 'void' then
    raise exception 'the form entry or its visit is void (EDC-03)' using errcode = 'check_violation';
  end if;
  if new.crf_item_id is null then
    select id into new.crf_item_id from core.crf_item where crf_version_id = e.crf_version_id and oid = new.item_oid and status = 'active';
  end if;
  select id, oid, data_type, codelist_id, crf_version_id, status into it from core.crf_item where id = new.crf_item_id;
  if it.id is null or it.crf_version_id <> e.crf_version_id or it.status <> 'active' then
    raise exception 'item % is not in the CRF version of this form (EDC-03)', coalesce(new.item_oid, new.crf_item_id::text) using errcode = 'check_violation';
  end if;
  new.item_oid := it.oid; new.platform_id := e.platform_id; new.site_id := e.site_id; new.subject_id := e.subject_id;
  v_txt := nullif(btrim(coalesce(new.value, '')), '');
  if new.status = 'active' and (v_txt is null) = (new.missing_reason is null) then
    raise exception 'item %: enter a value or a missing-data reason (ND, NA, UNK), not both (EDC-03)', it.oid using errcode = 'check_violation';
  end if;
  new.value := v_txt; new.value_num := null; new.value_date := null;
  if v_txt is not null then
    if it.data_type = 'integer' then
      if v_txt !~ '^[+-]?[0-9]{1,12}$' then
        raise exception 'item %: % is not an integer (EDC-03)', it.oid, v_txt using errcode = 'check_violation';
      end if;
      new.value_num := v_txt::numeric; new.value := new.value_num::text;
    elsif it.data_type = 'decimal' then
      if v_txt !~ '^[+-]?([0-9]{1,12}(\.[0-9]{1,6})?|\.[0-9]{1,6})$' then
        raise exception 'item %: % is not a decimal number (EDC-03)', it.oid, v_txt using errcode = 'check_violation';
      end if;
      new.value_num := v_txt::numeric; new.value := new.value_num::text;
    elsif it.data_type = 'date' then
      if v_txt !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'item %: % is not a date YYYY-MM-DD (EDC-03)', it.oid, v_txt using errcode = 'check_violation';
      end if;
      begin
        new.value_date := v_txt::date;
      exception when others then
        raise exception 'item %: % is not a valid date (EDC-03)', it.oid, v_txt using errcode = 'check_violation';
      end;
    elsif it.data_type = 'coded' then
      if not exists (select 1 from core.codelist_term t where t.codelist_id = it.codelist_id and t.submission_value = v_txt) then
        raise exception 'item %: % is not a term of its codelist (rule 13)', it.oid, v_txt using errcode = 'check_violation';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value and new.missing_reason is not distinct from old.missing_reason
     and new.status = old.status then
    new.entered_by := old.entered_by; new.entered_at := old.entered_at; new.source := old.source;
  else
    -- rule 11 and ALCOA: author and time of the value are the server's
    new.entered_by := core.current_sub(); new.entered_at := clock_timestamp();
    new.source := case core.current_actor_type() when 'app' then 'app' when 'system' then 'system' else 'site_entry' end;
  end if;
  return new;
end $$;

-- After every value write: evaluate the checks that involve the item (hard failure aborts the write).
create or replace function core.item_value_checks() returns trigger language plpgsql security definer set search_path = core, public as $$
begin
  perform core.edc_evaluate(new.crf_entry_id, 'value', new.item_oid);
  return null;
end $$;

-- History of a value from the audit ledger (prior values, author, server time, reason), for the readers of the site data.
create or replace function core.item_value_history(p_value uuid)
returns table (seq bigint, occurred_at timestamptz, actor_sub text, action text, value text, missing_reason text, reason text)
language plpgsql stable security definer set search_path = core, public as $$
#variable_conflict use_column
declare v record;
begin
  select platform_id, site_id into v from core.item_value where id = p_value;
  if v.platform_id is null or not core.edc_claims_allow(v.platform_id, v.site_id) then
    raise exception 'value not found or outside your perimeter (IAM-02)' using errcode = 'insufficient_privilege';
  end if;
  return query
    select a.seq, a.occurred_at, a.actor_sub, a.action, a.new_row->>'value', a.new_row->>'missing_reason', a.reason
      from core.audit_event a where a.table_name = 'item_value' and a.record_id = p_value order by a.seq;
end $$;

-- =====================================================================================================================
-- EDC-05 · query state machine
-- =====================================================================================================================
create or replace function core.edc_query_fsm() returns trigger language plpgsql as $$
declare
  e record;
  allowed jsonb := '{"open":["answered","closed","cancelled"],"answered":["closed","open"],"closed":[],"cancelled":[]}';
begin
  if tg_op = 'INSERT' then
    select platform_id, site_id, subject_id, crf_version_id into e from core.crf_entry where id = new.crf_entry_id;
    if e.platform_id is null then raise exception 'form entry not found (EDC-05)' using errcode = 'foreign_key_violation'; end if;
    if core.edc_api_caller() then
      if new.origin <> 'manual' then
        raise exception 'edit-check queries are opened only by the edit checks (EDC-04)' using errcode = 'insufficient_privilege';
      end if;
      if not core.has_any_role(array['data_manager', 'cra']) then
        raise exception 'a query is opened by a data manager or a monitor (cra) (EDC-05)' using errcode = 'insufficient_privilege';
      end if;
    end if;
    if new.crf_item_id is not null and not exists (select 1 from core.crf_item i where i.id = new.crf_item_id and i.crf_version_id = e.crf_version_id) then
      raise exception 'the item of the query is not in the form (EDC-05)' using errcode = 'check_violation';
    end if;
    if new.item_value_id is not null and not exists (select 1 from core.item_value v where v.id = new.item_value_id and v.crf_entry_id = new.crf_entry_id) then
      raise exception 'the value of the query is not in the form (EDC-05)' using errcode = 'check_violation';
    end if;
    new.platform_id := e.platform_id; new.site_id := e.site_id; new.subject_id := e.subject_id;
    new.status := 'open'; new.opened_by := core.current_sub(); new.opened_at := clock_timestamp();
    new.answer := null; new.answered_by := null; new.answered_at := null;
    new.close_reason := null; new.closed_by := null; new.closed_at := null;
    return new;
  end if;
  if (new.platform_id, new.site_id, new.subject_id, new.crf_entry_id, new.item_value_id, new.crf_item_id, new.edit_check_id, new.origin,
      new.question, new.opened_by, new.opened_at)
     is distinct from (old.platform_id, old.site_id, old.subject_id, old.crf_entry_id, old.item_value_id, old.crf_item_id, old.edit_check_id,
      old.origin, old.question, old.opened_by, old.opened_at) then
    raise exception 'the subject, item and question of a query cannot change (EDC-05)' using errcode = 'insufficient_privilege';
  end if;
  if new.status = old.status then
    if (new.answer, new.answered_by, new.answered_at, new.close_reason, new.closed_by, new.closed_at)
       is distinct from (old.answer, old.answered_by, old.answered_at, old.close_reason, old.closed_by, old.closed_at) then
      raise exception 'a query changes only through its workflow (EDC-05)' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if not coalesce((allowed->old.status) ? new.status, false) then
    raise exception 'query status % -> % not allowed (EDC-05)', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status = 'answered' then
    if core.edc_api_caller() and not core.has_any_role(array['site_pi', 'study_coordinator']) then
      raise exception 'a query is answered by the site (site_pi, study_coordinator) (EDC-05)' using errcode = 'insufficient_privilege';
    end if;
    if length(btrim(coalesce(new.answer, ''))) = 0 then
      raise exception 'an answer is required (EDC-05)' using errcode = 'check_violation';
    end if;
    new.answer := btrim(new.answer); new.answered_by := core.current_sub(); new.answered_at := clock_timestamp();
    new.close_reason := null; new.closed_by := null; new.closed_at := null;
  elsif new.status in ('closed', 'cancelled') then
    if core.edc_api_caller() and not core.has_any_role(array['data_manager', 'cra']) then
      raise exception 'a query is closed or cancelled by a data manager or a monitor (cra) (EDC-05)' using errcode = 'insufficient_privilege';
    end if;
    if length(btrim(coalesce(new.close_reason, ''))) = 0 then
      raise exception 'a reason is required to close or cancel a query (EDC-05)' using errcode = 'check_violation';
    end if;
    new.answer := old.answer; new.answered_by := old.answered_by; new.answered_at := old.answered_at;
    new.close_reason := btrim(new.close_reason); new.closed_by := core.current_sub(); new.closed_at := clock_timestamp();
  else   -- answered -> open: re-query; the previous answer stays in the audit trail
    if core.edc_api_caller() and not core.has_any_role(array['data_manager', 'cra']) then
      raise exception 'a query is re-opened by a data manager or a monitor (cra) (EDC-05)' using errcode = 'insufficient_privilege';
    end if;
    new.answer := null; new.answered_by := null; new.answered_at := null;
    new.close_reason := null; new.closed_by := null; new.closed_at := null;
  end if;
  return new;
end $$;

-- =====================================================================================================================
-- triggers
-- =====================================================================================================================
do $$
declare t text;
begin
  foreach t in array array['codelist', 'codelist_term', 'visit_definition', 'crf_form', 'crf_version', 'crf_item', 'crf_edit_check', 'crf_visit'] loop
    if not exists (select 1 from pg_trigger where tgrelid = format('core.%I', t)::regclass and tgname = 'guard') then
      execute format($f$create trigger guard before insert or update on core.%I for each row
        execute function core.edc_guard('data_manager', 'platform_admin')$f$, t);
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'core.codelist'::regclass and tgname = 'integrity') then
    create trigger integrity before insert or update on core.codelist for each row execute function core.codelist_integrity();
    create trigger integrity before insert on core.codelist_term for each row execute function core.codelist_term_integrity();
    create trigger integrity before insert or update on core.visit_definition for each row execute function core.visit_definition_integrity();
    create trigger integrity before insert or update on core.crf_form for each row execute function core.crf_form_integrity();
    create trigger integrity before insert or update on core.crf_version for each row execute function core.crf_version_integrity();
    create trigger integrity before insert or update on core.crf_item for each row execute function core.crf_definition_integrity();
    create trigger integrity before insert or update on core.crf_edit_check for each row execute function core.crf_definition_integrity();
    create trigger integrity before insert or update on core.crf_visit for each row execute function core.crf_definition_integrity();
    create trigger integrity before insert or update on core.subject_visit for each row execute function core.subject_visit_integrity();
    create trigger integrity before insert or update on core.crf_entry for each row execute function core.crf_entry_integrity();
    create trigger integrity before insert or update on core.item_value for each row execute function core.item_value_integrity();
    create trigger provenance before insert or update on core.item_value for each row execute function core.stamp_provenance();
    create trigger checks after insert or update of value, missing_reason, status on core.item_value
      for each row execute function core.item_value_checks();
    create trigger fsm before insert or update on core.edc_query for each row execute function core.edc_query_fsm();
  end if;
end $$;
comment on column core.item_value.source_app is 'App that wrote the current origin of the row, from the verified token (APP-DT-05)';

-- =====================================================================================================================
-- EDC-12 · data collection time per completed visit (TA3-DATA-COLLECT: data available - visit date). Platform level only.
-- =====================================================================================================================
create or replace view core.v_visit_data_collection with (security_barrier) as
select v.id as subject_visit_id, v.platform_id, v.site_id, d.code as visit_code, v.visit_date, v.completed_at,
       round((extract(epoch from v.completed_at - (v.visit_date::timestamp at time zone 'UTC')) / 86400.0)::numeric, 2) as days_to_data
  from core.subject_visit v join core.visit_definition d on d.id = v.visit_definition_id
 where v.status = 'completed' and core.can_see_platform(v.platform_id) and core.can_see_site(v.site_id)
   and core.edc_clinical_reader(v.platform_id);

-- =====================================================================================================================
-- RLS and grants (no delete anywhere, DM-03; no grant to anon)
-- =====================================================================================================================
do $$
declare t text;
begin
  foreach t in array array['codelist', 'codelist_term', 'visit_definition', 'crf_form', 'crf_version', 'crf_item', 'crf_edit_check', 'crf_visit'] loop
    execute format('alter table core.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'core' and tablename = t and policyname = 'scope') then
      execute format('create policy scope on core.%I using (core.can_see_platform(platform_id)) with check (core.can_see_platform(platform_id))', t);
    end if;
  end loop;
  foreach t in array array['subject_visit', 'crf_entry', 'item_value', 'edc_query'] loop
    execute format('alter table core.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'core' and tablename = t and policyname = 'scope') then
      execute format($p$create policy scope on core.%I
        using (core.can_see_platform(platform_id) and core.can_see_site(site_id) and core.edc_clinical_reader(platform_id))
        with check (core.can_see_platform(platform_id) and core.can_see_site(site_id))$p$, t);
    end if;
  end loop;
end $$;

revoke all on core.codelist, core.codelist_term, core.visit_definition, core.crf_form, core.crf_version, core.crf_item, core.crf_edit_check,
  core.crf_visit, core.subject_visit, core.crf_entry, core.item_value, core.edc_query, core.v_visit_data_collection
  from public, anon, authenticated, app_service, unblinded;
grant select, insert, update on core.codelist, core.visit_definition, core.crf_form, core.crf_version, core.crf_item, core.crf_edit_check,
  core.crf_visit, core.subject_visit, core.crf_entry, core.item_value, core.edc_query to authenticated;
grant select, insert on core.codelist_term to authenticated;
grant select on core.codelist, core.codelist_term, core.visit_definition, core.crf_form, core.crf_version, core.crf_item, core.crf_edit_check,
  core.crf_visit, core.subject_visit, core.crf_entry to app_service;
grant select, insert, update on core.item_value to app_service;
grant select on core.v_visit_data_collection to authenticated, app_service;

revoke execute on function core.edc_api_caller(), core.edc_app_scope(uuid, text), core.edc_reader_roles(), core.edc_clinical_reader(uuid),
  core.edc_claims_allow(uuid, uuid), core.edc_guard(), core.edc_today(), core.codelist_integrity(), core.codelist_term_integrity(),
  core.visit_definition_integrity(), core.crf_form_integrity(), core.crf_version_integrity(), core.crf_definition_integrity(),
  core.edc_check_passes(core.crf_edit_check, uuid), core.edc_evaluate(uuid, text, text), core.edc_run_checks(uuid), core.edc_site_staff(),
  core.subject_visit_integrity(), core.crf_entry_integrity(), core.item_value_integrity(), core.item_value_checks(),
  core.item_value_history(uuid), core.edc_query_fsm() from public;
-- helpers evaluated with the caller's rights inside policies and invoker triggers
grant execute on function core.edc_api_caller(), core.edc_app_scope(uuid, text), core.edc_reader_roles(), core.edc_clinical_reader(uuid),
  core.edc_claims_allow(uuid, uuid), core.edc_today(), core.edc_site_staff() to authenticated, app_service;
-- edc_evaluate checks the caller's perimeter from the token (it is reached through the triggers and edc_run_checks)
grant execute on function core.edc_evaluate(uuid, text, text) to authenticated, app_service;
grant execute on function core.edc_run_checks(uuid), core.item_value_history(uuid) to authenticated;
