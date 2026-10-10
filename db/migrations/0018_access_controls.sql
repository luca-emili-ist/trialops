-- TrialOps · 0018 access controls: sign-in events, account lockout, session idle timeout
-- Req: CMP-03 (21 CFR 11.10(d), 11.300(d); Annex 11 §12; EMA 2023 guideline on computerised systems, security),
--      IAM-01 (MFA enrolment recorded; signing with MFA step-up is enforced by the Platform API).
-- Design:
--   * core.auth_event: append-only record of sign-in and session events. Every row is also copied into the hash-chained
--     audit ledger (core.audit_row), so the audit trail review (CMP-10) shows them.
--   * core.account_lock: a lock opened after repeated failures; closed only by a platform administrator with a reason.
--   * core.user_session: one row per Supabase session (claim session_id) with its last activity, for the idle timeout.
--     Session start and end are audited; the once-a-minute heartbeat (last_seen_at) is not, it is a technical value.
--   * Writes go only through the security definer functions below. They are executable only by the role auth_service,
--     which the Platform API takes for its own bookkeeping (it is never reachable through PostgREST: anon and
--     authenticated have no grant on these tables or functions), plus two functions for platform administrators.
--     No user can clear their own failures or lock.
--   * Passwords and one-time codes are never stored. Emails are stored lowercased.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'auth_service') then create role auth_service nologin; end if;
end $$;
-- The API connects as the migration owner and takes this role with SET LOCAL ROLE (like anon/authenticated/app_service).
do $$ begin execute format('grant auth_service to %I', current_user); end $$;
grant usage on schema core to auth_service;

-- ===== events =====
create table core.auth_event (
  id          uuid primary key default gen_random_uuid(),
  event       text not null check (event in ('login_succeeded', 'login_failed', 'account_locked', 'account_unlocked',
                                             'session_idle_timeout', 'signature_reauth_failed', 'mfa_enrolled', 'logout')),
  email       text check (email = lower(email)),
  sub         text,
  session_id  text,
  ip          text,
  detail      jsonb not null default '{}',
  actor_sub   text not null default core.current_sub(),   -- who caused the event (the person, an admin, or system:auth)
  at          timestamptz not null default clock_timestamp(),
  check (email is not null or sub is not null)
);
comment on table core.auth_event is 'Sign-in, lockout and session events (CMP-03, IAM-01); append-only, mirrored in core.audit_event';
create index on core.auth_event (email, at);
create index on core.auth_event (sub, at);

-- Rule 11: the time of an event is the server clock, never a value supplied by the caller.
create or replace function core.auth_event_stamp() returns trigger language plpgsql as $$
begin
  new.at := clock_timestamp();
  new.actor_sub := core.current_sub();
  return new;
end $$;
create trigger stamp before insert on core.auth_event for each row execute function core.auth_event_stamp();
create trigger audit after insert on core.auth_event for each row execute function core.audit_row('gxp');
create trigger immutable before update or delete on core.auth_event for each row execute function core.audit_immutable();
create trigger immutable_truncate before truncate on core.auth_event execute function core.audit_immutable();

-- ===== locks =====
create table core.account_lock (
  id            uuid primary key default gen_random_uuid(),
  email         text check (email = lower(email)),
  sub           text,
  failures      int not null,
  locked_at     timestamptz not null default clock_timestamp(),
  locked_until  timestamptz not null,
  unlocked_at   timestamptz,
  unlocked_by   text,
  unlock_reason text,
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  row_version   int not null default 1,
  check (email is not null or sub is not null),
  check (locked_until > locked_at),
  check ((unlocked_at is null) = (unlocked_by is null) and (unlocked_at is null) = (unlock_reason is null))
);
comment on table core.account_lock is 'Account lockout after repeated failed sign-in or signature attempts (CMP-03)';
create index on core.account_lock (email) where unlocked_at is null;
create index on core.account_lock (sub) where unlocked_at is null;
select core.attach_std('core.account_lock');   -- unlock is an UPDATE: audited, with the reason (DM-03)

-- A lock is opened by the server and may only be closed once (unlock), never edited or reopened.
create or replace function core.account_lock_controls() returns trigger language plpgsql as $$
begin
  if old.unlocked_at is not null then
    raise exception 'an unlocked account lock is closed and cannot change (CMP-03)' using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - 'unlocked_at' - 'unlocked_by' - 'unlock_reason' - 'updated_at' - 'row_version')
     is distinct from (to_jsonb(old) - 'unlocked_at' - 'unlocked_by' - 'unlock_reason' - 'updated_at' - 'row_version') then
    raise exception 'an account lock can only be closed by an unlock (CMP-03)' using errcode = 'insufficient_privilege';
  end if;
  new.unlocked_at := clock_timestamp();
  return new;
end $$;
create trigger lock_controls before update on core.account_lock for each row execute function core.account_lock_controls();

-- ===== sessions =====
create table core.user_session (
  id            uuid primary key default gen_random_uuid(),
  session_id    text not null unique,            -- Supabase claim session_id
  sub           text not null,
  email         text check (email = lower(email)),
  started_at    timestamptz not null default clock_timestamp(),
  last_seen_at  timestamptz not null default clock_timestamp(),
  ended_at      timestamptz,
  end_reason    text check (end_reason in ('idle_timeout', 'logout')),
  check ((ended_at is null) = (end_reason is null))
);
comment on table core.user_session is 'Server-side session activity for the idle timeout (CMP-03); start and end audited, heartbeat not';

-- Only the heartbeat may move (forward, while open); an ended session stays ended; nothing else changes.
create or replace function core.user_session_controls() returns trigger language plpgsql as $$
begin
  if old.ended_at is not null then
    raise exception 'session % has ended and cannot be reopened (CMP-03)', old.session_id using errcode = 'insufficient_privilege';
  end if;
  if (new.id, new.session_id, new.sub, new.email, new.started_at) is distinct from (old.id, old.session_id, old.sub, old.email, old.started_at) then
    raise exception 'a session record cannot be edited (CMP-03)' using errcode = 'insufficient_privilege';
  end if;
  if new.last_seen_at < old.last_seen_at then
    raise exception 'session activity cannot move back in time (CMP-03)' using errcode = 'check_violation';
  end if;
  if new.ended_at is not null then new.ended_at := clock_timestamp(); end if;
  return new;
end $$;
create trigger session_controls before update on core.user_session for each row execute function core.user_session_controls();
create trigger audit after insert or update of ended_at on core.user_session for each row execute function core.audit_row('operational');
create trigger no_delete before delete on core.user_session for each row execute function core.audit_row('operational');
create trigger no_truncate before truncate on core.user_session execute function core.audit_immutable();
create trigger no_truncate before truncate on core.account_lock execute function core.audit_immutable();

-- RLS on, no policy and no grant for app roles: only the functions below (owner) read and write these tables.
alter table core.auth_event enable row level security;
alter table core.account_lock enable row level security;
alter table core.user_session enable row level security;
revoke all on core.auth_event, core.account_lock, core.user_session from public, anon, authenticated, app_service;

-- ===== internal helpers (not granted) =====
create or replace function core.auth_clamp(v int, lo int, hi int) returns int language sql immutable as $$
  select least(greatest(coalesce(v, lo), lo), hi)
$$;

-- The subject of an email, when the person is known (sign-in failures come with an email only).
create or replace function core.auth_sub_of(p_email text) returns text language sql stable security definer set search_path = core, public as $$
  select idp_sub from core.person where lower(email) = lower(p_email) limit 1
$$;

-- The open lock of an identity (by email or subject), if any.
create or replace function core.auth_active_lock(p_email text, p_sub text) returns core.account_lock
language sql stable security definer set search_path = core, public as $$
  select * from core.account_lock
   where unlocked_at is null and locked_until > clock_timestamp()
     and ((p_email is not null and email = lower(p_email)) or (p_sub is not null and sub = p_sub))
   order by locked_until desc limit 1
$$;

create or replace function core.auth_log(p_event text, p_email text, p_sub text, p_session text, p_ip text, p_detail jsonb)
returns void language sql security definer set search_path = core, public as $$
  insert into core.auth_event(event, email, sub, session_id, ip, detail)
  values (p_event, lower(nullif(btrim(p_email), '')), nullif(p_sub, ''), p_session, nullif(p_ip, ''), coalesce(p_detail, '{}'))
$$;

-- ===== functions for the Platform API (role auth_service) =====

-- Before a sign-in: the lock of this email, if any (the API then refuses without contacting the identity provider).
-- The refused attempt is recorded; it does not count towards a new lock.
create or replace function core.auth_login_check(p_email text, p_ip text default null) returns timestamptz
language plpgsql security definer set search_path = core, public as $$
declare l core.account_lock; v_email text := lower(btrim(p_email));
begin
  l := core.auth_active_lock(v_email, core.auth_sub_of(v_email));
  if l.id is null then return null; end if;
  perform core.auth_log('login_failed', v_email, coalesce(l.sub, core.auth_sub_of(v_email)), null, p_ip,
    jsonb_build_object('reason', 'account_locked', 'locked_until', l.locked_until));
  return l.locked_until;
end $$;

-- A failed sign-in (password or one-time code) or signature re-authentication. Opens a lock when the failures of this
-- identity within the window (and since its last unlock) reach the maximum. A successful password sign-in does not reset
-- the count, otherwise someone holding the password could try one-time codes without limit. Returns locked_until when
-- the identity is locked after this failure, null otherwise.
create or replace function core.auth_failure(p_event text, p_email text, p_sub text, p_ip text, p_detail jsonb,
  p_max int, p_window_min int, p_lock_min int) returns timestamptz
language plpgsql security definer set search_path = core, public as $$
declare
  v_email text := lower(nullif(btrim(p_email), ''));
  v_sub text := coalesce(nullif(p_sub, ''), core.auth_sub_of(v_email));
  v_max int := core.auth_clamp(p_max, 3, 100);
  v_window interval := make_interval(mins => core.auth_clamp(p_window_min, 1, 1440));
  v_lock interval := make_interval(mins => core.auth_clamp(p_lock_min, 1, 10080));
  v_since timestamptz; v_n int; l core.account_lock;
begin
  if p_event not in ('login_failed', 'signature_reauth_failed') then
    raise exception 'not a failure event: %', p_event using errcode = 'check_violation';
  end if;
  -- one identity at a time, so two parallel failures cannot both stay under the threshold
  perform pg_advisory_xact_lock(hashtext('auth:' || coalesce(v_email, '') || '|' || coalesce(v_sub, '')));
  perform core.auth_log(p_event, v_email, v_sub, null, p_ip, p_detail);
  l := core.auth_active_lock(v_email, v_sub);
  if l.id is not null then return l.locked_until; end if;
  select greatest(clock_timestamp() - v_window,
           (select max(at) from core.auth_event e where e.event = 'account_unlocked'
              and ((v_email is not null and e.email = v_email) or (v_sub is not null and e.sub = v_sub))))
    into v_since;
  select count(*)::int into v_n from core.auth_event e
   where e.event in ('login_failed', 'signature_reauth_failed') and e.at > v_since
     and coalesce(e.detail->>'reason', '') <> 'account_locked'
     and ((v_email is not null and e.email = v_email) or (v_sub is not null and e.sub = v_sub));
  if v_n < v_max then return null; end if;
  insert into core.account_lock(email, sub, failures, locked_until)
  values (v_email, v_sub, v_n, clock_timestamp() + v_lock) returning * into l;
  perform core.auth_log('account_locked', v_email, v_sub, null, p_ip,
    jsonb_build_object('lock_id', l.id, 'failures', v_n, 'locked_until', l.locked_until, 'last_event', p_event));
  return l.locked_until;
end $$;

-- A successful password sign-in (assurance level aal1 until the one-time code is verified): recorded, session opened.
create or replace function core.auth_login_succeeded(p_email text, p_sub text, p_session text, p_ip text, p_aal text)
returns void language plpgsql security definer set search_path = core, public as $$
begin
  perform core.auth_log('login_succeeded', p_email, p_sub, p_session, p_ip, jsonb_build_object('aal', p_aal));
  if p_session is not null then
    insert into core.user_session(session_id, sub, email) values (p_session, p_sub, lower(p_email)) on conflict (session_id) do nothing;
  end if;
end $$;

create or replace function core.auth_mfa_enrolled(p_email text, p_sub text, p_session text, p_factor text)
returns void language sql security definer set search_path = core, public as $$
  select core.auth_log('mfa_enrolled', p_email, p_sub, p_session, null, jsonb_build_object('factor_id', p_factor, 'factor_type', 'totp'))
$$;

-- Access check of every authenticated request (verified token claims passed by the API). Returns
--   'ok' | 'account_locked' | 'session_idle' (ended now or earlier for inactivity) | 'session_ended' (logged out).
-- The heartbeat is written at most once a minute. A session idle for longer than p_idle_min is ended for good.
create or replace function core.access_check(p_sub text, p_email text, p_session text, p_idle_min int)
returns text language plpgsql security definer set search_path = core, public as $$
declare s core.user_session; v_idle interval := make_interval(mins => core.auth_clamp(p_idle_min, 1, 1440));
begin
  if (core.auth_active_lock(p_email, p_sub)).id is not null then return 'account_locked'; end if;
  if p_session is null then return 'ok'; end if;
  select * into s from core.user_session where session_id = p_session for update;
  if s.id is null then
    insert into core.user_session(session_id, sub, email) values (p_session, p_sub, lower(p_email)) on conflict (session_id) do nothing;
    return 'ok';
  end if;
  if s.sub <> p_sub then return 'session_ended'; end if;
  if s.ended_at is not null then return case s.end_reason when 'idle_timeout' then 'session_idle' else 'session_ended' end; end if;
  if clock_timestamp() - s.last_seen_at > v_idle then
    update core.user_session set ended_at = clock_timestamp(), end_reason = 'idle_timeout' where id = s.id;
    perform core.auth_log('session_idle_timeout', p_email, p_sub, p_session, null,
      jsonb_build_object('last_seen_at', s.last_seen_at, 'idle_minutes', core.auth_clamp(p_idle_min, 1, 1440), 'source', 'server'));
    return 'session_idle';
  end if;
  if clock_timestamp() - s.last_seen_at >= interval '1 minute' then
    update core.user_session set last_seen_at = clock_timestamp() where id = s.id;
  end if;
  return 'ok';
end $$;

-- The client ends its own session: sign-out, or its idle timer expired before any request reached the server.
create or replace function core.auth_session_end(p_sub text, p_email text, p_session text, p_reason text, p_idle_min int default null)
returns boolean language plpgsql security definer set search_path = core, public as $$
declare s core.user_session;
begin
  if p_reason not in ('logout', 'idle_timeout') then raise exception 'unknown end reason %', p_reason using errcode = 'check_violation'; end if;
  select * into s from core.user_session where session_id = p_session and sub = p_sub for update;
  if s.id is null or s.ended_at is not null then return false; end if;
  update core.user_session set ended_at = clock_timestamp(), end_reason = p_reason where id = s.id;
  perform core.auth_log(case p_reason when 'logout' then 'logout' else 'session_idle_timeout' end, p_email, p_sub, p_session, null,
    case p_reason when 'logout' then '{}'::jsonb
      else jsonb_build_object('last_seen_at', s.last_seen_at, 'idle_minutes', p_idle_min, 'source', 'client') end);
  return true;
end $$;

-- ===== functions for platform administrators (role authenticated, claims checked) =====
create or replace function core.auth_require_admin() returns void language plpgsql stable as $$
begin
  if not (core.current_actor_type() = 'user' and coalesce(core.jwt()->'roles', '[]'::jsonb) ? 'platform_admin') then
    raise exception 'account locks are managed by a platform administrator (CMP-03)' using errcode = 'insufficient_privilege';
  end if;
end $$;

create or replace function core.account_locks_open()
returns table (id uuid, email text, sub text, failures int, locked_at timestamptz, locked_until timestamptz)
language plpgsql stable security definer set search_path = core, public as $$
begin
  perform core.auth_require_admin();
  return query select l.id, l.email, l.sub, l.failures, l.locked_at, l.locked_until from core.account_lock l
    where l.unlocked_at is null and l.locked_until > clock_timestamp() order by l.locked_at desc;
end $$;

-- Closes the open locks of an account (by email or subject). Needs the change reason; an administrator cannot unlock
-- their own account. Returns the number of locks closed.
create or replace function core.account_unlock(p_email text, p_sub text default null) returns int
language plpgsql security definer set search_path = core, public as $$
declare
  v_reason text := nullif(btrim(current_setting('trialops.change_reason', true)), '');
  v_email text := lower(nullif(btrim(p_email), ''));
  v_sub text := coalesce(nullif(p_sub, ''), core.auth_sub_of(v_email));
  v_n int;
begin
  perform core.auth_require_admin();
  if v_reason is null then raise exception 'a reason is required to unlock an account (DM-03)' using errcode = 'check_violation'; end if;
  if (v_sub is not null and v_sub = core.current_sub()) or (v_email is not null and v_email = lower(core.jwt()->>'email')) then
    raise exception 'an administrator cannot unlock their own account (CMP-03)' using errcode = 'insufficient_privilege';
  end if;
  update core.account_lock set unlocked_at = clock_timestamp(), unlocked_by = core.current_sub(), unlock_reason = v_reason
   where unlocked_at is null and locked_until > clock_timestamp()
     and ((v_email is not null and email = v_email) or (v_sub is not null and sub = v_sub));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform core.auth_log('account_unlocked', v_email, v_sub, null, null, jsonb_build_object('locks', v_n, 'reason', v_reason));
  end if;
  return v_n;
end $$;

revoke execute on function core.auth_clamp(int, int, int), core.auth_sub_of(text), core.auth_active_lock(text, text),
  core.auth_log(text, text, text, text, text, jsonb), core.auth_login_check(text, text),
  core.auth_failure(text, text, text, text, jsonb, int, int, int), core.auth_login_succeeded(text, text, text, text, text),
  core.auth_mfa_enrolled(text, text, text, text), core.access_check(text, text, text, int),
  core.auth_session_end(text, text, text, text, int), core.auth_require_admin(), core.account_locks_open(),
  core.account_unlock(text, text) from public;
grant execute on function core.auth_login_check(text, text), core.auth_failure(text, text, text, text, jsonb, int, int, int),
  core.auth_login_succeeded(text, text, text, text, text), core.auth_mfa_enrolled(text, text, text, text),
  core.access_check(text, text, text, int), core.auth_session_end(text, text, text, text, int) to auth_service;
grant execute on function core.auth_require_admin(), core.account_locks_open(), core.account_unlock(text, text) to authenticated;
