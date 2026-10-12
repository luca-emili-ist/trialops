-- TrialOps · 0020 change requests ("Suggest changes", decided by Luca Emili on 2026-10-12)
-- Req: UX-02 (Annex 11 §10 change management input, §9 audit trail of the triage)
-- Any signed-in person can switch a page into suggestion mode, pick a numbered component (code <PAGE CODE>.Cnn, e.g.
-- TRO-010.C04) and describe what should change. The request is stored here; platform admins triage it in TRO-060.
--   * insert: a person (not an agent or app), on a platform of the token, in their own name, status 'new', no note;
--     author, time (server UTC) and status are set by the database, never taken from the client (rule 11);
--   * read: every person of the platform (the panel shows what is already open on the same page);
--   * update: platform admins only, and only status and triage note; every change is audited (attach_std);
--   * no physical delete (rule 3): "delete" is status 'void', with a reason, and a void request is closed.
-- Not clinical data: page and component text are what the person saw on screen, already blinded for them (rule 5).
-- Idempotent: it can be run again.

create table if not exists core.change_request (
  id             uuid primary key default gen_random_uuid(),
  platform_id    uuid not null references core.platform(id),
  page_code      text not null check (page_code ~ '^[A-Z]{2,4}-[0-9]{3}$'),
  component_code text check (component_code ~ '^[A-Z]{2,4}-[0-9]{3}\.C[0-9]{2,3}$'),
  component_kind text check (component_kind in ('table', 'card', 'heading', 'toolbar', 'chart', 'field', 'section', 'component')),
  component_text text check (length(component_text) <= 500),   -- 120 characters, trimmed by the API; bound in bytes too
  dom_path       text check (length(dom_path) <= 1000),
  route          text check (length(route) <= 500),
  kind           text not null default 'change' check (kind in ('change', 'bug', 'new')),
  request        text not null check (length(btrim(request)) > 0 and length(request) <= 4000),
  status         text not null default 'new' check (status in ('new', 'triaged', 'in_progress', 'done', 'rejected', 'void')),
  triage_note    text not null default '' check (length(triage_note) <= 2000),
  created_by     text not null default core.current_sub(),
  created_email  text,
  created_at     timestamptz not null default clock_timestamp(),
  updated_by     text,
  updated_at     timestamptz not null default clock_timestamp(),
  row_version    int not null default 1
);
comment on table core.change_request is 'Changes suggested from the pages (Suggest changes, UX-02); triaged by platform admins, audited, void instead of delete';
-- re-runs bring an older copy of the table to the current bound
alter table core.change_request drop constraint if exists change_request_component_text_check;
alter table core.change_request add constraint change_request_component_text_check check (length(component_text) <= 500);
create index if not exists change_request_page_idx on core.change_request (platform_id, page_code, status);

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'core.change_request'::regclass and tgname = 'audit') then
    perform core.attach_std('core.change_request', 'operational');   -- every insert and status change audited (CMP-15)
  end if;
end $$;

create or replace function core.is_change_admin() returns boolean language sql stable as $$
  select core.current_actor_type() = 'user' and coalesce(core.jwt()->'roles', '[]'::jsonb) ? 'platform_admin'
$$;

-- Author, time and initial status come from the server; afterwards only an admin moves the status and the note.
create or replace function core.change_request_controls() returns trigger language plpgsql as $$
declare api boolean := current_user in ('authenticated', 'app_service');
begin
  if tg_op = 'INSERT' then
    if api and core.current_actor_type() <> 'user' then
      raise exception 'a change request is suggested by a person (UX-02)' using errcode = 'insufficient_privilege';
    end if;
    new.created_by := core.current_sub();
    new.created_email := lower(nullif(core.jwt()->>'email', ''));
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    new.updated_by := null;
    new.row_version := 1;
    new.status := 'new';
    new.triage_note := '';
    return new;
  end if;
  if api and not core.is_change_admin() then
    raise exception 'only a platform admin can triage a change request (UX-02)' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'void' then
    raise exception 'a void change request is closed (UX-02)' using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - 'status' - 'triage_note' - 'updated_by' - 'updated_at' - 'row_version')
     is distinct from (to_jsonb(old) - 'status' - 'triage_note' - 'updated_by' - 'updated_at' - 'row_version') then
    raise exception 'only the status and the triage note of a change request can change (UX-02)' using errcode = 'insufficient_privilege';
  end if;
  if new.status = 'void' and nullif(current_setting('trialops.change_reason', true), '') is null then
    raise exception 'voiding a change request needs a reason (DM-03)' using errcode = 'check_violation';
  end if;
  new.updated_by := core.current_sub();
  return new;
end $$;
drop trigger if exists change_request_controls on core.change_request;
create trigger change_request_controls before insert or update on core.change_request
  for each row execute function core.change_request_controls();

alter table core.change_request enable row level security;
drop policy if exists read on core.change_request;
create policy read on core.change_request for select using (core.can_see_platform(platform_id));
drop policy if exists suggest on core.change_request;
create policy suggest on core.change_request for insert
  with check (core.can_see_platform(platform_id) and created_by = core.current_sub() and status = 'new' and triage_note = '');
drop policy if exists triage on core.change_request;
create policy triage on core.change_request for update
  using (core.can_see_platform(platform_id) and core.is_change_admin())
  with check (core.can_see_platform(platform_id) and core.is_change_admin());
revoke all on core.change_request from public, anon, app_service;
grant select, insert, update on core.change_request to authenticated;
