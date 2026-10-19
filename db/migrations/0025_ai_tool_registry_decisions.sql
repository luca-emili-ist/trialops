-- TrialOps · 0025 AI tool registry (AUTO/CONFIRM/BLOCK) and signed Agent Decision Records
-- Req: AI-07 (every tool an agent can invoke is registered with a mode: AUTO runs without a person, CONFIRM creates a
--      pending action that a person with the right role confirms before it runs, BLOCK is always refused; mode changes
--      are versioned and audited, made only by a platform admin with a reason; an unregistered tool is BLOCK; a GxP
--      write is never AUTO), AI-08 (an internal, deterministic policy engine decides ALLOW / REVIEW / BLOCK for every
--      agent tool call and writes a signed, hash-chained Agent Decision Record; Deontos stays out of scope, decision 4).
--   * core.ai_tool: the registry. platform_id null = the platform default, set only by migrations (change control);
--     a platform admin overrides the mode for one platform through core.ai_tool_set_mode() (a person, a reason, audited
--     with attach_std 'gxp'). Effect 'gxp_write' can never be AUTO (check constraint + function). Every insert and
--     update writes a version row in core.ai_tool_version (append-only), which decision records point to.
--   * core.ai_pending_action: a CONFIRM (or AI-10 suggestion-only) tool call waiting for a person. Created only by the
--     agent through core.ai_pending_action_create() with its REVIEW decision record; decided only by a person whose
--     roles include one of confirm_roles, through core.ai_pending_action_decide() (reason, audited, no delete).
--   * core.agent_decision_record (0005): written only through core.agent_decision_append(). The policy engine (API,
--     packages/api/src/lib/policy-engine.ts) builds the canonical payload, the database gives the next sequence number,
--     the previous record hash and the server UTC time (core.agent_decision_head(), which serialises writers), the
--     engine signs the payload with Ed25519 (key outside the database, like the CMP-12 seal) and the database checks
--     sha256, sequence, chain, time, actor and key before inserting. A record without a signature is accepted only as
--     signature_status 'unsigned' (production without a configured key): it is a monitoring anomaly, never hidden.
--   * core.ai_decision_key: public keys of the decision signer (key_id = first 16 hex of sha256 of the SPKI DER, checked
--     here), append-only and audited; the private key never enters the database or the repository.
-- Grants: select on the new tables to authenticated (RLS by platform); execute on the functions to authenticated
-- (revoked from public). Tightening of an existing table: core.agent_decision_record gets RLS (platform perimeter) and
-- loses the direct INSERT grant of 0006 (it is written only by core.agent_decision_append). No DROP of existing objects.
-- Idempotent: it can be run again.

-- ===== tool registry (AI-07) =====
create table if not exists core.ai_tool (
  id             uuid primary key default gen_random_uuid(),
  platform_id    uuid references core.platform(id),          -- null: platform default (migrations only)
  tool           text not null check (tool ~ '^[a-z0-9_.-]{1,100}$'),
  description    text not null check (length(btrim(description)) between 1 and 500),
  effect         text not null check (effect in ('read', 'proposal', 'operational_write', 'gxp_write')),
  risk_level     text not null check (risk_level in ('low', 'medium', 'high')),
  agents         text[] not null default '{}',               -- agents allowed to invoke the tool
  confirm_roles  text[] not null default '{}',               -- roles of the person who confirms a pending action
  mode           text not null check (mode in ('AUTO', 'CONFIRM', 'BLOCK')),
  version        int not null default 1 check (version >= 1),
  reason         text not null check (length(btrim(reason)) between 1 and 2000),
  changed_by     text not null default core.current_sub(),
  changed_at     timestamptz not null default clock_timestamp(),
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  row_version    int not null default 1,
  constraint ai_tool_gxp_write_never_auto check (effect <> 'gxp_write' or mode <> 'AUTO'),
  constraint ai_tool_confirm_needs_roles check (mode <> 'CONFIRM' or cardinality(confirm_roles) > 0)
);
comment on table core.ai_tool is 'AI-07 tool registry: mode AUTO/CONFIRM/BLOCK per tool (platform_id null = default); changed only by core.ai_tool_set_mode, audited';
create unique index if not exists ai_tool_scope_uq on core.ai_tool (coalesce(platform_id, '00000000-0000-0000-0000-000000000000'::uuid), tool);

create table if not exists core.ai_tool_version (
  id             uuid primary key default gen_random_uuid(),
  ai_tool_id     uuid not null references core.ai_tool(id),
  platform_id    uuid references core.platform(id),
  tool           text not null,
  version        int not null,
  effect         text not null,
  risk_level     text not null,
  agents         text[] not null,
  confirm_roles  text[] not null,
  mode           text not null,
  reason         text not null,
  changed_by     text not null,
  changed_at     timestamptz not null,
  unique (ai_tool_id, version)
);
comment on table core.ai_tool_version is 'AI-07 version history of core.ai_tool, written by trigger; append-only';

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ai_tool'::regclass and tgname = 'audit') then
    perform core.attach_std('core.ai_tool', 'gxp');
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ai_tool_version'::regclass and tgname = 'no_change') then
    create trigger no_change before update or delete on core.ai_tool_version for each row execute function core.audit_immutable();
    create trigger no_truncate before truncate on core.ai_tool_version execute function core.audit_immutable();
  end if;
end $$;

-- Identity and definition of a registry row change only through a migration (owner); the API changes mode and reason.
-- The version grows with every change; who and when are set by the database.
create or replace function core.ai_tool_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.platform_id is distinct from old.platform_id or new.tool is distinct from old.tool or new.created_at is distinct from old.created_at then
      raise exception 'platform and tool of a registry entry cannot change (AI-07)' using errcode = 'insufficient_privilege';
    end if;
    if current_user in ('authenticated', 'app_service', 'anon') and (new.effect is distinct from old.effect
        or new.agents is distinct from old.agents or new.confirm_roles is distinct from old.confirm_roles
        or new.risk_level is distinct from old.risk_level or new.description is distinct from old.description) then
      raise exception 'the definition of a tool changes only through a migration (AI-07)' using errcode = 'insufficient_privilege';
    end if;
    new.version := old.version + 1;
  else
    new.version := 1;
  end if;
  new.changed_by := core.current_sub();
  new.changed_at := clock_timestamp();
  return new;
end $$;

create or replace function core.ai_tool_record_version() returns trigger language plpgsql security definer set search_path = core, public as $$
begin
  insert into core.ai_tool_version(ai_tool_id, platform_id, tool, version, effect, risk_level, agents, confirm_roles, mode, reason, changed_by, changed_at)
  values (new.id, new.platform_id, new.tool, new.version, new.effect, new.risk_level, new.agents, new.confirm_roles, new.mode, new.reason,
          new.changed_by, new.changed_at);
  return null;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ai_tool'::regclass and tgname = 'guard') then
    create trigger guard before insert or update on core.ai_tool for each row execute function core.ai_tool_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ai_tool'::regclass and tgname = 'record_version') then
    create trigger record_version after insert or update on core.ai_tool for each row execute function core.ai_tool_record_version();
  end if;
end $$;

-- Initial registry (defaults for every platform). The agents of demo v0 (spec §9): the Protocol author proposes an
-- appendix (a proposal for human review and signature, AI-05), the Onboarding planner creates operational tasks assigned
-- to roles. Writing appendix sections directly is a GxP write: registered as BLOCK, an agent never does it.
insert into core.ai_tool (platform_id, tool, description, effect, risk_level, agents, confirm_roles, mode, reason) values
  (null, 'protocol.appendix.propose', 'Leave an AI draft of an arm appendix in the task for review and signature by a person (AI-05)',
   'proposal', 'medium', '{protocol-author}', '{platform_admin,platform_ops_manager,regulatory_lead}', 'AUTO', 'Initial registry (AI-07, migration 0025)'),
  (null, 'onboarding.tasks.create', 'Create the operational tasks of an arm onboarding plan, assigned to roles',
   'operational_write', 'low', '{onboarding-planner}', '{platform_admin,platform_ops_manager}', 'AUTO', 'Initial registry (AI-07, migration 0025)'),
  (null, 'protocol.appendix.write', 'Write sections of an arm appendix (GxP record) without a person''s review',
   'gxp_write', 'high', '{protocol-author}', '{regulatory_lead}', 'BLOCK', 'Initial registry (AI-07, migration 0025): GxP content is written only by people')
on conflict do nothing;

-- Entry in force for a platform: the platform override if any, else the default.
create or replace function core.ai_tool_resolve(p_platform uuid, p_tool text)
returns table (id uuid, platform_id uuid, tool text, description text, effect text, risk_level text, agents text[], confirm_roles text[],
               mode text, version int, version_id uuid, reason text, changed_by text, changed_at timestamptz)
language sql stable as $$
  select t.id, t.platform_id, t.tool, t.description, t.effect, t.risk_level, t.agents, t.confirm_roles, t.mode, t.version, v.id,
         t.reason, t.changed_by, t.changed_at
    from core.ai_tool t join core.ai_tool_version v on v.ai_tool_id = t.id and v.version = t.version
   where t.tool = p_tool and (t.platform_id = p_platform or t.platform_id is null)
   order by t.platform_id nulls last limit 1
$$;

create or replace function core.ai_tool_set_mode(p_platform uuid, p_tool text, p_mode text, p_reason text) returns core.ai_tool
language plpgsql security definer set search_path = core, public as $$
declare v_cur core.ai_tool; v_def core.ai_tool; v_new core.ai_tool;
begin
  if core.current_actor_type() <> 'user' or not (coalesce(core.jwt()->'roles', '[]'::jsonb) ? 'platform_admin') then
    raise exception 'only a platform admin (a person) changes the mode of an AI tool (AI-07)' using errcode = 'insufficient_privilege';
  end if;
  if p_platform is null then
    raise exception 'the default registry changes only through a migration; give a platform (AI-07)' using errcode = 'check_violation';
  end if;
  if core.claim_uuid_list('platform_ids') is not null and not p_platform = any(core.claim_uuid_list('platform_ids')) then
    raise exception 'platform outside the token (AI-07)' using errcode = 'insufficient_privilege';
  end if;
  if p_mode is null or p_mode not in ('AUTO', 'CONFIRM', 'BLOCK') then
    raise exception 'mode must be AUTO, CONFIRM or BLOCK (AI-07)' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'changing the mode of an AI tool needs a reason (DM-03)' using errcode = 'check_violation';
  end if;
  select * into v_cur from core.ai_tool where platform_id = p_platform and tool = p_tool for update;
  if not found then
    select * into v_def from core.ai_tool where platform_id is null and tool = p_tool;
    if not found then
      raise exception 'tool % is not registered (AI-07): unregistered tools are BLOCK', p_tool using errcode = 'check_violation';
    end if;
  end if;
  if coalesce(v_cur.effect, v_def.effect) = 'gxp_write' and p_mode = 'AUTO' then
    raise exception 'a GxP write tool can never be AUTO (AI-07)' using errcode = 'check_violation';
  end if;
  if v_cur.id is not null and v_cur.mode = p_mode then return v_cur; end if;     -- already in that mode: nothing to record
  perform set_config('trialops.change_reason', btrim(p_reason), true);
  if v_cur.id is null then
    insert into core.ai_tool (platform_id, tool, description, effect, risk_level, agents, confirm_roles, mode, reason)
    values (p_platform, p_tool, v_def.description, v_def.effect, v_def.risk_level, v_def.agents, v_def.confirm_roles, p_mode, btrim(p_reason))
    returning * into v_new;
  else
    update core.ai_tool set mode = p_mode, reason = btrim(p_reason) where id = v_cur.id returning * into v_new;
  end if;
  return v_new;
end $$;

-- Platform perimeter of the caller's token. Used inside security definer functions, where core.can_see_platform() would
-- see the owner and always answer true.
create or replace function core.ai_claims_platform(p uuid) returns boolean language sql stable as $$
  select p is not null and (core.claim_uuid_list('platform_ids') is null or p = any(core.claim_uuid_list('platform_ids')))
$$;

-- ===== Agent Decision Record (AI-08) =====
create table if not exists core.ai_decision_key (
  key_id          text primary key check (key_id ~ '^[0-9a-f]{16}$'),
  platform_id     uuid references core.platform(id),      -- null: the key signs decisions of every platform
  algorithm       text not null default 'ed25519' check (algorithm = 'ed25519'),
  public_key_pem  text not null check (public_key_pem like '-----BEGIN PUBLIC KEY-----%'),
  ephemeral       boolean not null default false,         -- generated by a development or test process
  registered_by   text not null default core.current_sub(),
  registered_at   timestamptz not null default clock_timestamp()
);
comment on table core.ai_decision_key is 'AI-08 public keys of the decision signer (Ed25519); append-only, audited; the private key never enters the database';

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ai_decision_key'::regclass and tgname = 'no_change') then
    create trigger no_change before update or delete on core.ai_decision_key for each row execute function core.audit_immutable();
    create trigger no_truncate before truncate on core.ai_decision_key execute function core.audit_immutable();
    create trigger audit after insert on core.ai_decision_key for each row execute function core.audit_row('gxp');
  end if;
end $$;

alter table core.agent_decision_record add column if not exists seq bigint;
alter table core.agent_decision_record add column if not exists prev_record_sha256 text;
alter table core.agent_decision_record add column if not exists signed_payload text;
alter table core.agent_decision_record add column if not exists signature_status text;
alter table core.agent_decision_record add column if not exists key_id text;
alter table core.agent_decision_record add column if not exists arm_id uuid;
alter table core.agent_decision_record add column if not exists tool_version_id uuid;
alter table core.agent_decision_record add column if not exists tool_mode text;
alter table core.agent_decision_record add column if not exists inputs_sha256 text;
alter table core.agent_decision_record add column if not exists pending_action_id uuid;
alter table core.agent_decision_record add column if not exists ai_request_id uuid;
alter table core.agent_decision_record add column if not exists model text;
alter table core.agent_decision_record add column if not exists prompt_id text;
alter table core.agent_decision_record add column if not exists prompt_version text;
alter table core.agent_decision_record add column if not exists actor_sub text;
alter table core.agent_decision_record add column if not exists actor_type text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agent_decision_record_seq_uq') then
    alter table core.agent_decision_record add constraint agent_decision_record_seq_uq unique (seq);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_decision_record_signed_check') then
    -- rows of 0025 on: chained and either signed with a registered key or explicitly unsigned
    alter table core.agent_decision_record add constraint agent_decision_record_signed_check check (seq is null or (
      prev_record_sha256 ~ '^[0-9a-f]{64}$' and record_sha256 ~ '^[0-9a-f]{64}$' and signed_payload is not null
      and actor_sub is not null and actor_type in ('agent', 'user')
      and ((signature_status = 'signed' and signature_ed25519 is not null and key_id is not null)
        or (signature_status = 'unsigned' and signature_ed25519 is null and key_id is null))));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_decision_record_key_fk') then
    alter table core.agent_decision_record add constraint agent_decision_record_key_fk foreign key (key_id) references core.ai_decision_key(key_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_decision_record_tool_version_fk') then
    alter table core.agent_decision_record add constraint agent_decision_record_tool_version_fk foreign key (tool_version_id) references core.ai_tool_version(id);
  end if;
end $$;
create index if not exists agent_decision_record_platform_idx on core.agent_decision_record (platform_id, decided_at desc);
create index if not exists agent_decision_record_task_idx on core.agent_decision_record (task_id);

-- Next sequence number, previous record hash and server UTC time. Takes a transaction lock: decision records are
-- written one transaction at a time, so the chain has no fork. Callable by agents and people (the policy engine).
create or replace function core.agent_decision_head()
returns table (next_seq bigint, prev_record_sha256 text, decided_at text)
language plpgsql volatile security definer set search_path = core, public as $$
#variable_conflict use_column
declare v_seq bigint; v_hash text;
begin
  if core.current_actor_type() not in ('agent', 'user') then
    raise exception 'decision records are written by the policy engine for agents and people (AI-08)' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(424245);
  select r.seq, r.record_sha256 into v_seq, v_hash from core.agent_decision_record r where r.seq is not null order by r.seq desc limit 1;
  return query select coalesce(v_seq, 0) + 1, coalesce(v_hash, repeat('0', 64)),
    to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
end $$;

-- Appends a decision record. p_payload is the canonical JSON the engine hashed and signed; every column is taken from
-- it, so row and signed content cannot differ. p_request holds the tool arguments (their sha256 is inputs_sha256).
create or replace function core.agent_decision_append(p_payload text, p_record_sha256 text, p_signature text, p_public_key_pem text,
  p_request jsonb, p_ephemeral_key boolean default false) returns uuid
language plpgsql security definer set search_path = core, public as $$
declare j jsonb; v_seq bigint; v_hash text; v_last_at timestamptz; v_at timestamptz; v_key text; v_id uuid; v_status text;
begin
  if core.current_actor_type() not in ('agent', 'user') then
    raise exception 'decision records are written by the policy engine for agents and people (AI-08)' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(424245);
  begin j := p_payload::jsonb; exception when others then
    raise exception 'decision payload is not JSON (AI-08)' using errcode = 'check_violation';
  end;
  if encode(sha256(convert_to(p_payload, 'UTF8')), 'hex') <> p_record_sha256 then
    raise exception 'record hash does not match the decision payload (AI-08)' using errcode = 'check_violation';
  end if;
  select r.seq, r.record_sha256, r.decided_at into v_seq, v_hash, v_last_at
    from core.agent_decision_record r where r.seq is not null order by r.seq desc limit 1;
  if (j->>'v') is distinct from '1' or (j->>'seq')::bigint is distinct from coalesce(v_seq, 0) + 1
     or (j->>'prev_record_sha256') is distinct from coalesce(v_hash, repeat('0', 64)) then
    raise exception 'decision record out of chain: sequence or previous hash differs (AI-08)' using errcode = 'check_violation';
  end if;
  v_at := (j->>'decided_at')::timestamptz;
  if v_at is null or abs(extract(epoch from clock_timestamp() - v_at)) > 300 or (v_last_at is not null and v_at < v_last_at) then
    raise exception 'decision time must be the server time of core.agent_decision_head() (AI-08, rule 11)' using errcode = 'check_violation';
  end if;
  if (j->>'actor_sub') is distinct from core.current_sub() or (j->>'actor_type') is distinct from core.current_actor_type() then
    raise exception 'decision actor must be the caller (AI-08)' using errcode = 'check_violation';
  end if;
  if (j->>'platform_id') is null or not core.ai_claims_platform((j->>'platform_id')::uuid) then
    raise exception 'platform outside the token (AI-08)' using errcode = 'insufficient_privilege';
  end if;
  if coalesce((j->>'decision') not in ('ALLOW', 'REVIEW', 'BLOCK'), true) or coalesce(jsonb_typeof(j->'rule_ids'), '') <> 'array'
     or length(coalesce(j->>'rationale', '')) = 0 or coalesce((j->>'inputs_sha256') !~ '^[0-9a-f]{64}$', true)
     or coalesce(length(j->>'agent_id'), 0) = 0 or coalesce(length(j->>'tool'), 0) = 0 then
    raise exception 'decision, rule ids, rationale, agent, tool and inputs hash are required (AI-08)' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(j->'rule_ids') = 0 then
    raise exception 'decision, rule ids, rationale and inputs hash are required (AI-08)' using errcode = 'check_violation';
  end if;
  v_key := j->>'key_id';
  if p_signature is null then
    if v_key is not null then raise exception 'a key id without a signature (AI-08)' using errcode = 'check_violation'; end if;
    v_status := 'unsigned';
  else
    if v_key is null then raise exception 'a signature needs the key id in the payload (AI-08)' using errcode = 'check_violation'; end if;
    if not exists (select 1 from core.ai_decision_key k where k.key_id = v_key) then
      if p_public_key_pem is null or left(encode(sha256(decode(regexp_replace(p_public_key_pem, '-----(BEGIN|END) PUBLIC KEY-----|\s', '', 'g'), 'base64')), 'hex'), 16) <> v_key then
        raise exception 'unknown decision signing key % (AI-08)', v_key using errcode = 'check_violation';
      end if;
      insert into core.ai_decision_key(key_id, public_key_pem, ephemeral) values (v_key, p_public_key_pem, coalesce(p_ephemeral_key, false));
    end if;
    v_status := 'signed';
  end if;
  insert into core.agent_decision_record (id, agent_id, tool, platform_id, task_id, request, decision, policies_applied, rationale,
      record_sha256, signature_ed25519, decided_at, seq, prev_record_sha256, signed_payload, signature_status, key_id, arm_id,
      tool_version_id, tool_mode, inputs_sha256, pending_action_id, ai_request_id, model, prompt_id, prompt_version, actor_sub, actor_type)
  values ((j->>'id')::uuid, j->>'agent_id', j->>'tool', (j->>'platform_id')::uuid, (j->>'task_id')::uuid, coalesce(p_request, '{}'),
      j->>'decision', array(select jsonb_array_elements_text(j->'rule_ids')), j->>'rationale', p_record_sha256, p_signature, v_at,
      (j->>'seq')::bigint, j->>'prev_record_sha256', p_payload, v_status, v_key, (j->>'arm_id')::uuid, (j->>'tool_version_id')::uuid,
      j->>'tool_mode', j->>'inputs_sha256', (j->>'pending_action_id')::uuid, (j->>'ai_request_id')::uuid, j->>'model', j->>'prompt_id',
      j->>'prompt_version', j->>'actor_sub', j->>'actor_type')
  returning id into v_id;
  return v_id;
end $$;

-- The whole chain, for the verifier (API GET /v1/ai/decisions/verify): QA auditors and platform admins only. The chain
-- spans every platform; arguments are not returned, only the signed payloads.
create or replace function core.agent_decision_chain()
returns table (id uuid, seq bigint, prev_record_sha256 text, record_sha256 text, signed_payload text, signature_ed25519 text,
               signature_status text, key_id text, decided_at timestamptz, inputs_sha256 text)
language plpgsql stable security definer set search_path = core, public as $$
#variable_conflict use_column
begin
  perform core.audit_require_reviewer();
  return query select r.id, r.seq, r.prev_record_sha256, r.record_sha256, r.signed_payload, r.signature_ed25519, r.signature_status,
    r.key_id, r.decided_at, r.inputs_sha256
    from core.agent_decision_record r where r.seq is not null order by r.seq;
end $$;

create or replace function core.ai_decision_keys()
returns table (key_id text, public_key_pem text, ephemeral boolean, registered_by text, registered_at timestamptz)
language sql stable security definer set search_path = core, public as $$
  select k.key_id, k.public_key_pem, k.ephemeral, k.registered_by, k.registered_at from core.ai_decision_key k order by k.registered_at
$$;

-- ===== pending actions (AI-07 CONFIRM) =====
create table if not exists core.ai_pending_action (
  id                   uuid primary key default gen_random_uuid(),
  platform_id          uuid not null references core.platform(id),
  arm_id               uuid references core.arm(id),
  task_id              uuid references core.task(id),
  agent_id             text not null,
  tool                 text not null,
  tool_version_id      uuid not null references core.ai_tool_version(id),
  args                 jsonb not null,
  args_sha256          text not null check (args_sha256 ~ '^[0-9a-f]{64}$'),
  confirm_roles        text[] not null check (cardinality(confirm_roles) > 0),
  status               text not null default 'pending' check (status in ('pending', 'executed', 'rejected', 'blocked')),
  request_decision_id  uuid not null references core.agent_decision_record(id),
  requested_by         text not null default core.current_sub(),
  requested_at         timestamptz not null default clock_timestamp(),
  decided_by           text,
  decided_at           timestamptz,
  decision_reason      text,
  final_decision_id    uuid references core.agent_decision_record(id),
  result               jsonb,
  created_at           timestamptz not null default clock_timestamp(),
  updated_at           timestamptz not null default clock_timestamp(),
  row_version          int not null default 1,
  check (status = 'pending' or (decided_by is not null and decided_at is not null and final_decision_id is not null))
);
comment on table core.ai_pending_action is 'AI-07 agent tool call waiting for a person (CONFIRM): created by the agent, confirmed or rejected by a person with a confirm role; audited';
create index if not exists ai_pending_action_open_idx on core.ai_pending_action (platform_id, status, requested_at desc);
create index if not exists ai_pending_action_task_idx on core.ai_pending_action (task_id);

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.ai_pending_action'::regclass and tgname = 'audit') then
    perform core.attach_std('core.ai_pending_action', 'gxp');
  end if;
end $$;

create or replace function core.ai_pending_action_create(p_id uuid, p_decision uuid, p_args jsonb) returns core.ai_pending_action
language plpgsql security definer set search_path = core, public as $$
declare d core.agent_decision_record; v_tool record; v_row core.ai_pending_action;
begin
  if core.current_actor_type() <> 'agent' then
    raise exception 'pending actions are created by agents (AI-07)' using errcode = 'insufficient_privilege';
  end if;
  select * into d from core.agent_decision_record where id = p_decision;
  if not found or d.decision <> 'REVIEW' or d.pending_action_id is distinct from p_id or d.actor_sub <> core.current_sub() then
    raise exception 'a pending action needs the REVIEW decision record of the same agent call (AI-08)' using errcode = 'check_violation';
  end if;
  if not core.ai_claims_platform(d.platform_id) then
    raise exception 'platform outside the token (AI-07)' using errcode = 'insufficient_privilege';
  end if;
  select v.* into v_tool from core.ai_tool_version v where v.id = d.tool_version_id;
  if not found then raise exception 'decision without a registered tool version (AI-07)' using errcode = 'check_violation'; end if;
  insert into core.ai_pending_action (id, platform_id, arm_id, task_id, agent_id, tool, tool_version_id, args, args_sha256, confirm_roles, request_decision_id)
  values (p_id, d.platform_id, d.arm_id, d.task_id, d.agent_id, d.tool, d.tool_version_id, coalesce(p_args, '{}'), d.inputs_sha256,
          v_tool.confirm_roles, d.id)
  returning * into v_row;
  return v_row;
end $$;

-- A person with one of the confirm roles decides. p_status: executed (confirmed and run), rejected, or blocked (the policy
-- engine refused at confirmation, e.g. the tool was set to BLOCK meanwhile). The final decision record must name this
-- pending action.
create or replace function core.ai_pending_action_decide(p_id uuid, p_status text, p_reason text, p_final_decision uuid, p_result jsonb default null)
returns core.ai_pending_action language plpgsql security definer set search_path = core, public as $$
declare v core.ai_pending_action; d core.agent_decision_record;
begin
  if core.current_actor_type() <> 'user' then
    raise exception 'only a person confirms or rejects an agent action (AI-07, AI-05)' using errcode = 'insufficient_privilege';
  end if;
  select * into v from core.ai_pending_action where id = p_id for update;
  if not found or not core.ai_claims_platform(v.platform_id) or not (v.arm_id is null or core.claim_uuid_list('arm_scopes') is null
     or v.arm_id = any(core.claim_uuid_list('arm_scopes'))) then
    raise exception 'pending action not found (AI-07)' using errcode = 'no_data_found';
  end if;
  if not (coalesce(core.jwt()->'roles', '[]'::jsonb) ?| v.confirm_roles) then
    raise exception 'confirming this agent action requires one of the roles: % (AI-07)', array_to_string(v.confirm_roles, ', ')
      using errcode = 'insufficient_privilege';
  end if;
  if v.status <> 'pending' then
    raise exception 'pending action is already %', v.status using errcode = 'check_violation';
  end if;
  if p_status is null or p_status not in ('executed', 'rejected', 'blocked') then
    raise exception 'status must be executed, rejected or blocked (AI-07)' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'deciding on an agent action needs a reason (DM-03)' using errcode = 'check_violation';
  end if;
  select * into d from core.agent_decision_record where id = p_final_decision;
  if not found or d.pending_action_id is distinct from p_id or d.actor_sub <> core.current_sub()
     or d.decision <> (array['ALLOW', 'BLOCK'])[(p_status <> 'executed')::int + 1] then
    raise exception 'the final decision record must be the policy decision of this confirmation (AI-08)' using errcode = 'check_violation';
  end if;
  perform set_config('trialops.change_reason', btrim(p_reason), true);
  update core.ai_pending_action set status = p_status, decided_by = core.current_sub(), decided_at = clock_timestamp(),
    decision_reason = btrim(p_reason), final_decision_id = p_final_decision, result = p_result
   where id = p_id returning * into v;
  return v;
end $$;

-- ===== row level security and grants =====
alter table core.ai_tool enable row level security;
alter table core.ai_tool_version enable row level security;
alter table core.ai_pending_action enable row level security;
alter table core.ai_decision_key enable row level security;
alter table core.agent_decision_record enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'core' and tablename = 'ai_tool' and policyname = 'read') then
    create policy read on core.ai_tool for select using (platform_id is null or core.can_see_platform(platform_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'core' and tablename = 'ai_tool_version' and policyname = 'read') then
    create policy read on core.ai_tool_version for select using (platform_id is null or core.can_see_platform(platform_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'core' and tablename = 'ai_pending_action' and policyname = 'read') then
    create policy read on core.ai_pending_action for select using (core.can_see_arm(platform_id, arm_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'core' and tablename = 'ai_decision_key' and policyname = 'read') then
    create policy read on core.ai_decision_key for select using (platform_id is null or core.can_see_platform(platform_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'core' and tablename = 'agent_decision_record' and policyname = 'read') then
    create policy read on core.agent_decision_record for select using (core.can_see_platform(platform_id));
  end if;
end $$;

revoke all on core.ai_tool, core.ai_tool_version, core.ai_pending_action, core.ai_decision_key from public, anon, authenticated, app_service;
grant select on core.ai_tool, core.ai_tool_version, core.ai_pending_action, core.ai_decision_key to authenticated;
revoke insert, update, delete, truncate on core.agent_decision_record from public, anon, authenticated, app_service;

revoke execute on function core.ai_tool_resolve(uuid, text),
  core.ai_tool_set_mode(uuid, text, text, text), core.agent_decision_head(),
  core.agent_decision_append(text, text, text, text, jsonb, boolean), core.agent_decision_chain(), core.ai_decision_keys(),
  core.ai_pending_action_create(uuid, uuid, jsonb), core.ai_pending_action_decide(uuid, text, text, uuid, jsonb) from public;
grant execute on function core.ai_tool_resolve(uuid, text), core.ai_tool_set_mode(uuid, text, text, text), core.agent_decision_head(),
  core.agent_decision_append(text, text, text, text, jsonb, boolean), core.agent_decision_chain(), core.ai_decision_keys(),
  core.ai_pending_action_create(uuid, uuid, jsonb), core.ai_pending_action_decide(uuid, text, text, uuid, jsonb) to authenticated;
