-- TrialOps · 0002 audit ledger, outbox, signatures
-- Req: CMP-01, CMP-02, CMP-04, DM-03, APP-DT-04, APP-AU-02, ARC-05, ARC-07

create table core.audit_event (
  seq          bigserial primary key,
  occurred_at  timestamptz not null default clock_timestamp(),
  actor_sub    text not null,
  actor_type   text not null check (actor_type in ('user','agent','app','system')),
  source_app   text,
  table_name   text not null,
  record_id    uuid,
  action       text not null check (action in ('INSERT','UPDATE','VOID','EXTERNAL')),
  old_row      jsonb,
  new_row      jsonb,
  reason       text,
  prev_hash    text,
  hash         text not null
);
comment on table core.audit_event is 'Append-only, hash-chained audit trail (CMP-01). Blocks are signed off-database by the audit signer (Ed25519).';

-- hash chain: serialize writers with an advisory lock so prev_hash is well defined
create or replace function core.audit_chain() returns trigger language plpgsql as $$
declare v_prev text;
begin
  perform pg_advisory_xact_lock(424242);
  select hash into v_prev from core.audit_event order by seq desc limit 1;
  new.prev_hash := coalesce(v_prev, repeat('0', 64));
  new.hash := encode(sha256(convert_to(
      new.prev_hash || '|' || new.occurred_at::text || '|' || new.actor_sub || '|' || new.actor_type || '|' ||
      new.table_name || '|' || coalesce(new.record_id::text,'') || '|' || new.action || '|' ||
      coalesce(new.old_row::text,'') || '|' || coalesce(new.new_row::text,'') || '|' || coalesce(new.reason,''),
    'UTF8')), 'hex');
  return new;
end $$;
create trigger audit_chain before insert on core.audit_event for each row execute function core.audit_chain();

create or replace function core.audit_immutable() returns trigger language plpgsql as $$
begin raise exception '% is append-only (CMP-01)', tg_table_name using errcode = 'insufficient_privilege'; end $$;
create trigger audit_no_update before update or delete on core.audit_event for each row execute function core.audit_immutable();
create trigger audit_no_truncate before truncate on core.audit_event execute function core.audit_immutable();

-- verify the full chain; returns first broken seq or null
create or replace function core.audit_verify() returns bigint language plpgsql stable as $$
declare r record; v_prev text := repeat('0',64); v_hash text;
begin
  for r in select * from core.audit_event order by seq loop
    v_hash := encode(sha256(convert_to(
      v_prev || '|' || r.occurred_at::text || '|' || r.actor_sub || '|' || r.actor_type || '|' ||
      r.table_name || '|' || coalesce(r.record_id::text,'') || '|' || r.action || '|' ||
      coalesce(r.old_row::text,'') || '|' || coalesce(r.new_row::text,'') || '|' || coalesce(r.reason,''),'UTF8')),'hex');
    if r.prev_hash <> v_prev or r.hash <> v_hash then return r.seq; end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;

-- Generic row audit for GxP tables. UPDATE needs a reason (DM-03), DELETE is forbidden (void instead).
create or replace function core.audit_row() returns trigger language plpgsql security definer set search_path = core, public as $$
declare v_reason text := nullif(current_setting('trialops.change_reason', true), '');
begin
  if tg_op = 'DELETE' then
    raise exception 'physical delete not allowed on GxP table %, use status = void (DM-03)', tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and v_reason is null and coalesce(tg_argv[0],'gxp') = 'gxp' then
    raise exception 'change reason required to update % (DM-03): set trialops.change_reason', tg_table_name
      using errcode = 'check_violation';
  end if;
  insert into core.audit_event(actor_sub, actor_type, source_app, table_name, record_id, action, old_row, new_row, reason)
  values (core.current_sub(), core.current_actor_type(), core.jwt()->>'app_id', tg_table_name,
          (to_jsonb(new)->>'id')::uuid,
          case when tg_op = 'UPDATE' and to_jsonb(new)->>'status' = 'void' and to_jsonb(old)->>'status' <> 'void' then 'VOID' else tg_op end,
          case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new), v_reason);
  return new;
end $$;

-- helper to attach standard triggers
create or replace function core.attach_std(t regclass, kind text default 'gxp') returns void language plpgsql as $$
begin
  execute format('create trigger touch before update on %s for each row execute function core.touch()', t);
  execute format('create trigger audit after insert or update on %s for each row execute function core.audit_row(%L)', t, kind);
  execute format('create trigger no_delete before delete on %s for each row execute function core.audit_row(%L)', t, kind);
end $$;

-- Outbox for domain events, CloudEvents 1.0 shaped (APP-DT-04)
create table core.event_outbox (
  id            uuid primary key default gen_random_uuid(),
  specversion   text not null default '1.0',
  type          text not null,
  source        text not null default 'trialops/core',
  subject       text,
  time          timestamptz not null default clock_timestamp(),
  platform_id   uuid,
  arm_id        uuid,
  data          jsonb not null default '{}',
  published_at  timestamptz
);
create index on core.event_outbox (published_at) where published_at is null;

create or replace function core.emit(p_type text, p_subject text, p_platform uuid, p_arm uuid, p_data jsonb)
returns uuid language sql security definer set search_path = core, public as $$
  insert into core.event_outbox(type, subject, platform_id, arm_id, data)
  values (p_type, p_subject, p_platform, p_arm, coalesce(p_data,'{}')) returning id
$$;

-- Part 11 electronic signatures (CMP-02, APP-ID-06)
create table core.signature (
  id              uuid primary key default gen_random_uuid(),
  signer_sub      text not null,
  signer_name     text not null,
  meaning         text not null check (meaning in ('author','review','approval','verification','responsibility')),
  target_table    text not null,
  target_id       uuid not null,
  target_hash     text not null,            -- sha256 of the signed content/version
  auth_method     text not null check (auth_method in ('reauth_password','reauth_mfa','sso_step_up')),
  signed_at       timestamptz not null default clock_timestamp(),
  requested_by_app text
);
create trigger audit after insert on core.signature for each row execute function core.audit_row('gxp');
create trigger no_change before update or delete on core.signature for each row execute function core.audit_immutable();
