-- TrialOps · 0019 audit trail review
-- Req: CMP-10 (21 CFR 11.10(b)(e), Annex 11 §9, EMA 2023 guideline on computerised systems §6.2 audit trail review,
--      FDA Q&A on electronic systems 2024): QA and inspectors consult, filter and export the audit trail, and record
--      their reviews with a signature of meaning 'review'.
-- App roles keep no grant on core.audit_event (0006): the only read path is core.audit_search(), which
--   * answers only to a person whose token carries qa_auditor or platform_admin (raises otherwise);
--   * never returns rows of tables in the sac_enclave schema (IAM-04, IAM-07: unblinded data stays in the enclave);
--   * removes the subject's arm_id from old/new values (rule 5 of CLAUDE.md: blinding by default);
--   * keeps rows of other platforms and arms out of sight (same perimeter claims as RLS, IAM-02).

-- ===== who may review =====
create or replace function core.is_audit_reviewer() returns boolean language sql stable as $$
  select core.current_actor_type() = 'user'
     and coalesce(core.jwt()->'roles', '[]'::jsonb) ?| array['qa_auditor', 'platform_admin']
$$;

create or replace function core.audit_require_reviewer() returns void language plpgsql stable as $$
begin
  if not core.is_audit_reviewer() then
    raise exception 'audit trail review requires a person with role qa_auditor or platform_admin (CMP-10)'
      using errcode = 'insufficient_privilege';
  end if;
end $$;

-- Perimeter of an audit row, from the claims (not from current_user: audit_search runs as its owner).
create or replace function core.audit_in_scope(p_table text, r jsonb) returns boolean language sql stable as $$
  with k as (
    select case when p_table = 'platform' then r->>'id' else r->>'platform_id' end as plat,
           case when p_table = 'arm' then r->>'id' when p_table = 'subject' then null else r->>'arm_id' end as arm
  )
  select (k.plat is null or core.claim_uuid_list('platform_ids') is null or k.plat::uuid = any(core.claim_uuid_list('platform_ids')))
     and (k.arm is null or core.claim_uuid_list('arm_scopes') is null or k.arm::uuid = any(core.claim_uuid_list('arm_scopes')))
  from k
$$;

-- Values a blinded reader must never see in the audit trail (IAM-04): the treatment allocation of a subject.
create or replace function core.audit_redact(p_table text, r jsonb) returns jsonb language sql immutable as $$
  select case when r is null then null when p_table = 'subject' then r - 'arm_id' else r end
$$;

-- ===== search =====
-- Newest first. Keyset pagination: pass the smallest seq of a page as p_before for the next one. p_limit null = all rows
-- (used for counts and exports); otherwise 1..10000. p_min_seq/p_max_seq bound the range of a recorded review.
create or replace function core.audit_search(
  p_table text default null, p_record uuid default null, p_actor text default null,
  p_from timestamptz default null, p_to timestamptz default null,
  p_limit int default 100, p_before bigint default null,
  p_min_seq bigint default null, p_max_seq bigint default null)
returns table (seq bigint, occurred_at timestamptz, actor_sub text, actor_type text, source_app text, table_name text,
               record_id uuid, action text, old_row jsonb, new_row jsonb, reason text, hash text)
language plpgsql stable security definer set search_path = core, public as $$
#variable_conflict use_column
begin
  perform core.audit_require_reviewer();
  return query
    select e.seq, e.occurred_at, e.actor_sub, e.actor_type, e.source_app, e.table_name, e.record_id, e.action,
           core.audit_redact(e.table_name, e.old_row), core.audit_redact(e.table_name, e.new_row), e.reason, e.hash
      from core.audit_event e
     where (p_table is null or e.table_name = p_table)
       and (p_record is null or e.record_id = p_record)
       and (p_actor is null or e.actor_sub ilike '%' || replace(replace(p_actor, '%', '\%'), '_', '\_') || '%')
       and (p_from is null or e.occurred_at >= p_from)
       and (p_to is null or e.occurred_at < p_to)
       and (p_before is null or e.seq < p_before)
       and (p_min_seq is null or e.seq >= p_min_seq)
       and (p_max_seq is null or e.seq <= p_max_seq)
       and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                        where n.nspname = 'sac_enclave' and c.relname = e.table_name)
       and core.audit_in_scope(e.table_name, coalesce(e.new_row, e.old_row))
     order by e.seq desc
     limit case when p_limit is null then null else least(greatest(p_limit, 1), 10000) end;
end $$;
comment on function core.audit_search is 'Audit trail review (CMP-10): QA/admin persons only; no sac_enclave rows; subject arm_id redacted';

-- The rows a review covers: same filters as the search, inside [from_seq, to_seq].
create or replace function core.audit_review_count(p_filters jsonb, p_from_seq bigint, p_to_seq bigint) returns int
language sql stable security definer set search_path = core, public as $$
  select count(*)::int from core.audit_search(
    p_filters->>'table', nullif(p_filters->>'record_id', '')::uuid, nullif(p_filters->>'actor', ''),
    nullif(p_filters->>'from', '')::timestamptz, nullif(p_filters->>'to', '')::timestamptz,
    null, null, p_from_seq, p_to_seq)
$$;

revoke execute on function core.is_audit_reviewer(), core.audit_require_reviewer(), core.audit_in_scope(text, jsonb),
  core.audit_redact(text, jsonb), core.audit_search(text, uuid, text, timestamptz, timestamptz, int, bigint, bigint, bigint),
  core.audit_review_count(jsonb, bigint, bigint) from public;
grant execute on function core.is_audit_reviewer(), core.audit_require_reviewer(), core.audit_in_scope(text, jsonb),
  core.audit_redact(text, jsonb), core.audit_search(text, uuid, text, timestamptz, timestamptz, int, bigint, bigint, bigint),
  core.audit_review_count(jsonb, bigint, bigint) to authenticated;

-- ===== recorded reviews =====
create table core.audit_review (
  id                uuid primary key default gen_random_uuid(),
  platform_id       uuid not null references core.platform(id),
  filters           jsonb not null default '{}',
  reviewed_from_seq bigint not null,
  reviewed_to_seq   bigint not null,
  row_count         int not null default 0,
  conclusion        text not null check (length(btrim(conclusion)) > 0),
  status            text not null default 'open' check (status in ('open', 'completed', 'void')),
  signature_id      uuid references core.signature(id),
  created_by        text not null default core.current_sub(),
  created_at        timestamptz not null default clock_timestamp(),
  updated_at        timestamptz not null default clock_timestamp(),
  row_version       int not null default 1,
  check (reviewed_from_seq <= reviewed_to_seq),
  check ((status = 'completed') = (signature_id is not null))
);
comment on table core.audit_review is 'Audit trail reviews (CMP-10); complete only with the reviewer''s signature of meaning review';
select core.attach_std('core.audit_review');

-- A review is created open by a reviewer (row_count computed here, never trusted from the client), completed only with
-- a 'review' signature of its author on this very review, and frozen afterwards. Void only while open (DM-03).
create or replace function core.audit_review_controls() returns trigger language plpgsql security definer set search_path = core, public as $$
declare s core.signature%rowtype;
begin
  perform core.audit_require_reviewer();
  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.signature_id is not null then
      raise exception 'a review is created open and completed by its signature (CMP-10)' using errcode = 'check_violation';
    end if;
    if jsonb_typeof(new.filters) <> 'object' or exists (select 1 from jsonb_object_keys(new.filters) k
         where k not in ('table', 'record_id', 'actor', 'from', 'to')) then
      raise exception 'review filters may only contain table, record_id, actor, from, to (CMP-10)' using errcode = 'check_violation';
    end if;
    new.created_by := core.current_sub();
    new.created_at := clock_timestamp();
    new.row_count := core.audit_review_count(new.filters, new.reviewed_from_seq, new.reviewed_to_seq);
    return new;
  end if;
  if old.status <> 'open' then
    raise exception 'a % audit review is immutable (CMP-10)', old.status using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - 'status' - 'signature_id' - 'updated_at' - 'row_version')
     is distinct from (to_jsonb(old) - 'status' - 'signature_id' - 'updated_at' - 'row_version') then
    raise exception 'an audit review cannot be edited; void it and record a new one (CMP-10)' using errcode = 'insufficient_privilege';
  end if;
  if new.status = 'completed' then
    select * into s from core.signature where id = new.signature_id;
    if s.id is null or s.target_table <> 'audit_review' or s.target_id <> new.id or s.meaning <> 'review' then
      raise exception 'an audit review is completed only by a signature of meaning review on that review (CMP-10)'
        using errcode = 'check_violation';
    end if;
    if s.signer_sub <> old.created_by then
      raise exception 'only the reviewer who recorded the review can sign it (CMP-10)' using errcode = 'insufficient_privilege';
    end if;
  elsif new.signature_id is not null then
    raise exception 'a signature completes a review; it cannot be attached otherwise (CMP-10)' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger review_controls before insert or update on core.audit_review
  for each row execute function core.audit_review_controls();

alter table core.audit_review enable row level security;
create policy scope on core.audit_review
  using (core.can_see_platform(platform_id) and (current_user not in ('authenticated', 'app_service') or core.is_audit_reviewer()))
  with check (core.can_see_platform(platform_id) and (current_user not in ('authenticated', 'app_service') or core.is_audit_reviewer()));
grant select, insert, update on core.audit_review to authenticated;
