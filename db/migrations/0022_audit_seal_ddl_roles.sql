-- TrialOps · 0022 audit seal, DDL audit, segregated database roles
-- Req: CMP-12 (21 CFR 11.10(e), Annex 11 §9, Japan ER/ES authenticity): the audit ledger is sealed in blocks with Ed25519
-- and anchored outside the database; DDL on audited objects is recorded; database admin roles are segregated.
--   * Seal: an off-database sealer (packages/api/src/lib/audit-seal.ts) reads the next block of core.audit_event, signs
--     it with an Ed25519 key that never enters the database, and appends it through core.audit_seal_append(). The database
--     checks continuity (from_seq follows the previous block), the head hash (the chain hash at to_seq, which commits to
--     every earlier entry) and the link to the previous seal; it cannot check Ed25519, the verifier does (public key).
--     Anchors (copies of each seal kept outside the database) are recorded in core.audit_anchor.
--   * DDL: an event trigger records every DDL on schemas core and sac_enclave in core.ddl_event (append-only), with the
--     login (session_user), the effective role and the statement.
--   * Roles: audit_sealer may only read the next block and append seals/anchors; trialops_api is the login the Platform
--     API should use instead of the owner (member of the request roles, no DDL, no ownership); core.db_role_review()
--     lists every role with admin attributes for the periodic access review.
-- Idempotent: it can be run again.

-- ===== seal =====
create table if not exists core.audit_seal (
  block_no        int primary key check (block_no >= 1),
  from_seq        bigint not null,
  to_seq          bigint not null,
  head_hash       text not null check (head_hash ~ '^[0-9a-f]{64}$'),
  prev_seal_hash  text not null check (prev_seal_hash ~ '^[0-9a-f]{64}$'),
  key_id          text not null check (length(key_id) between 1 and 100),
  signature       text not null check (length(signature) between 1 and 200),   -- Ed25519, base64
  seal_hash       text not null check (seal_hash ~ '^[0-9a-f]{64}$'),
  sealed_at       timestamptz not null default clock_timestamp(),
  sealed_by       text not null default core.current_sub(),
  check (to_seq >= from_seq)
);
comment on table core.audit_seal is 'Ed25519 seals of audit ledger blocks (CMP-12); append-only; signed off-database, verified with the public key';

create table if not exists core.audit_anchor (
  id          bigserial primary key,
  block_no    int not null references core.audit_seal(block_no),
  anchor      text not null check (length(anchor) between 1 and 100),     -- where the copy is kept, e.g. file, blob store
  ref         text not null check (length(ref) between 1 and 1000),       -- its reference there (path, URL, commit)
  anchored_at timestamptz not null default clock_timestamp()
);
comment on table core.audit_anchor is 'Copies of audit seals kept outside the database (CMP-12); append-only';

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.audit_seal'::regclass and tgname = 'no_change') then
    create trigger no_change before update or delete on core.audit_seal for each row execute function core.audit_immutable();
    create trigger no_truncate before truncate on core.audit_seal execute function core.audit_immutable();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'core.audit_anchor'::regclass and tgname = 'no_change') then
    create trigger no_change before update or delete on core.audit_anchor for each row execute function core.audit_immutable();
    create trigger no_truncate before truncate on core.audit_anchor execute function core.audit_immutable();
  end if;
end $$;

-- The payload that is signed: canonical JSON, keys sorted, as the sealer and the verifier build it.
create or replace function core.audit_seal_payload(p_block int, p_from bigint, p_to bigint, p_head text, p_prev text) returns text
language sql immutable as $$
  select format('{"block_no":%s,"from_seq":%s,"head_hash":"%s","prev_seal_hash":"%s","to_seq":%s,"v":1}', p_block, p_from, p_head, p_prev, p_to)
$$;

-- Next block to seal: entries after the last seal, at most p_max of them, with the chain hash at the last entry.
create or replace function core.audit_seal_next(p_max int default 1000)
returns table (block_no int, from_seq bigint, to_seq bigint, head_hash text, prev_seal_hash text, payload text)
language plpgsql stable security definer set search_path = core, public as $$
#variable_conflict use_column
declare v_last core.audit_seal; v_from bigint; v_to bigint; v_head text; v_prev text;
begin
  select * into v_last from core.audit_seal order by block_no desc limit 1;
  v_from := coalesce(v_last.to_seq, 0) + 1;
  select max(e.seq) into v_to from (select seq from core.audit_event where seq >= v_from order by seq limit greatest(p_max, 1)) e;
  if v_to is null then return; end if;
  select min(seq) into v_from from core.audit_event where seq >= v_from;
  select hash into v_head from core.audit_event where seq = v_to;
  v_prev := coalesce(v_last.seal_hash, repeat('0', 64));
  return query select coalesce(v_last.block_no, 0) + 1, v_from, v_to, v_head, v_prev,
    core.audit_seal_payload(coalesce(v_last.block_no, 0) + 1, v_from, v_to, v_head, v_prev);
end $$;

create or replace function core.audit_seal_append(p_block int, p_from bigint, p_to bigint, p_head text, p_key_id text, p_signature text)
returns text language plpgsql security definer set search_path = core, public as $$
declare v_last core.audit_seal; v_prev text; v_head text; v_hash text;
begin
  perform pg_advisory_xact_lock(424243);
  select * into v_last from core.audit_seal order by block_no desc limit 1;
  if p_block <> coalesce(v_last.block_no, 0) + 1 then
    raise exception 'seal block % out of order (next is %) (CMP-12)', p_block, coalesce(v_last.block_no, 0) + 1 using errcode = 'check_violation';
  end if;
  if p_from <> (select min(seq) from core.audit_event where seq > coalesce(v_last.to_seq, 0)) then
    raise exception 'seal block % must start at the first unsealed entry (CMP-12)', p_block using errcode = 'check_violation';
  end if;
  select hash into v_head from core.audit_event where seq = p_to;
  if v_head is null or v_head <> p_head then
    raise exception 'head hash of seal block % does not match the ledger at seq % (CMP-12)', p_block, p_to using errcode = 'check_violation';
  end if;
  v_prev := coalesce(v_last.seal_hash, repeat('0', 64));
  v_hash := encode(sha256(convert_to(core.audit_seal_payload(p_block, p_from, p_to, p_head, v_prev) || '.' || p_signature, 'UTF8')), 'hex');
  insert into core.audit_seal(block_no, from_seq, to_seq, head_hash, prev_seal_hash, key_id, signature, seal_hash)
  values (p_block, p_from, p_to, p_head, v_prev, p_key_id, p_signature, v_hash);
  return v_hash;
end $$;

create or replace function core.audit_anchor_append(p_block int, p_anchor text, p_ref text) returns bigint
language sql security definer set search_path = core, public as $$
  insert into core.audit_anchor(block_no, anchor, ref) values (p_block, p_anchor, p_ref) returning id
$$;

-- For the verifier and for reviewers: seals with their anchors.
create or replace function core.audit_seals()
returns table (block_no int, from_seq bigint, to_seq bigint, head_hash text, prev_seal_hash text, key_id text, signature text,
               seal_hash text, sealed_at timestamptz, anchors jsonb)
language sql stable security definer set search_path = core, public as $$
  select s.block_no, s.from_seq, s.to_seq, s.head_hash, s.prev_seal_hash, s.key_id, s.signature, s.seal_hash, s.sealed_at,
         coalesce((select jsonb_agg(jsonb_build_object('anchor', a.anchor, 'ref', a.ref, 'anchored_at', a.anchored_at) order by a.id)
                     from core.audit_anchor a where a.block_no = s.block_no), '[]')
    from core.audit_seal s order by s.block_no
$$;

-- ===== DDL audit =====
create table if not exists core.ddl_event (
  id               bigserial primary key,
  occurred_at      timestamptz not null default clock_timestamp(),
  login_role       text not null,
  effective_role   text not null,
  event            text not null,
  command_tag      text not null,
  object_type      text,
  object_identity  text,
  schema_name      text,
  statement        text
);
comment on table core.ddl_event is 'DDL on schemas core and sac_enclave (CMP-12), recorded by event trigger; append-only';

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ddl_event'::regclass and tgname = 'no_change') then
    create trigger no_change before update or delete on core.ddl_event for each row execute function core.audit_immutable();
    create trigger no_truncate before truncate on core.ddl_event execute function core.audit_immutable();
  end if;
end $$;

create or replace function core.ddl_record() returns event_trigger language plpgsql security definer set search_path = core, public as $$
declare r record;
begin
  if tg_event = 'sql_drop' then
    for r in select * from pg_event_trigger_dropped_objects() where schema_name in ('core', 'sac_enclave') loop
      insert into core.ddl_event(login_role, effective_role, event, command_tag, object_type, object_identity, schema_name, statement)
      values (session_user, current_user, tg_event, tg_tag, r.object_type, r.object_identity, r.schema_name, left(current_query(), 10000));
    end loop;
  else
    for r in select * from pg_event_trigger_ddl_commands() where schema_name in ('core', 'sac_enclave') loop
      insert into core.ddl_event(login_role, effective_role, event, command_tag, object_type, object_identity, schema_name, statement)
      values (session_user, current_user, tg_event, r.command_tag, r.object_type, r.object_identity, r.schema_name, left(current_query(), 10000));
    end loop;
  end if;
end $$;

-- Event triggers need a privileged owner (superuser locally, the postgres role on Supabase). If the platform refuses,
-- the migration still applies and core.ddl_audit_active() reports false: the deployment check must then stop.
do $$ begin
  if not exists (select 1 from pg_event_trigger where evtname = 'trialops_ddl_end') then
    create event trigger trialops_ddl_end on ddl_command_end execute function core.ddl_record();
  end if;
  if not exists (select 1 from pg_event_trigger where evtname = 'trialops_ddl_drop') then
    create event trigger trialops_ddl_drop on sql_drop execute function core.ddl_record();
  end if;
exception when insufficient_privilege then
  raise warning 'DDL audit event triggers not created: % (CMP-12 inactive until an admin creates them)', sqlerrm;
end $$;

create or replace function core.ddl_audit_active() returns boolean language sql stable as $$
  select count(*) = 2 from pg_event_trigger where evtname in ('trialops_ddl_end', 'trialops_ddl_drop') and evtenabled <> 'D'
$$;

-- ===== roles =====
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'audit_sealer') then create role audit_sealer nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'trialops_api') then create role trialops_api nologin noinherit; end if;
end $$;
do $$ begin execute format('grant audit_sealer to %I', current_user); end $$;
grant anon, authenticated, app_service, auth_service to trialops_api;   -- set role per request; never unblinded, never owner
grant usage on schema core to audit_sealer;

revoke all on core.audit_seal, core.audit_anchor, core.ddl_event from public, anon, authenticated, app_service, unblinded, auth_service, audit_sealer, trialops_api;
revoke all on sequence core.audit_anchor_id_seq, core.ddl_event_id_seq from public, anon, authenticated, app_service, unblinded, auth_service, audit_sealer, trialops_api;
revoke execute on function core.audit_seal_next(int), core.audit_seal_append(int, bigint, bigint, text, text, text),
  core.audit_anchor_append(int, text, text), core.audit_seals(), core.ddl_record() from public;
grant execute on function core.audit_seal_next(int), core.audit_seal_append(int, bigint, bigint, text, text, text),
  core.audit_anchor_append(int, text, text), core.audit_seals() to audit_sealer;

-- Access review (CMP-12, IAM): roles with admin attributes or owning TrialOps objects; reviewers only.
create or replace function core.db_role_review()
returns table (role_name text, can_login boolean, superuser boolean, create_role boolean, create_db boolean, bypass_rls boolean,
               replication boolean, owns_objects int, member_of text[])
language plpgsql stable security definer set search_path = core, public, pg_catalog as $$
#variable_conflict use_column
begin
  perform core.audit_require_reviewer();
  return query
    select r.rolname::text, r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relowner = r.oid and n.nspname in ('core', 'sac_enclave')),
           array(select g.rolname::text from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid order by 1)
      from pg_roles r
     where r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication
        or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where c.relowner = r.oid and n.nspname in ('core', 'sac_enclave'))
     order by 1;
end $$;
revoke execute on function core.db_role_review() from public;
grant execute on function core.db_role_review() to authenticated;
