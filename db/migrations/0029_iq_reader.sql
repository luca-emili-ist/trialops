-- TrialOps · 0029 least-privilege role for the installation qualification
-- Req: VAL-02 (Annex 11 §4, EMA 2023 validation, JP CSV life cycle, 21 CFR 11.10(a)): scripts/iq-check.mjs runs after
-- every deploy with IQ_DATABASE_URL. That connection must not be the owner: it only needs to
--   * read the migration ledger public.schema_migrations                       (check db.migrations)
--   * run the audit chain verification                                         (check db.audit_chain)
--   * read whether the DDL audit event triggers are active                     (check db.ddl_audit)
-- core.audit_verify() is SECURITY INVOKER and reads every column of core.audit_event, old_row/new_row included, which can
-- carry clinical and unblinded values. iq_reader therefore gets no select on core.audit_event nor on any GxP table
-- (CLAUDE.md rule 5, blinding): it calls core.iq_audit_verify(), a SECURITY DEFINER wrapper that returns only the
-- sequence number of the first broken link (or null), never a row.
-- The role is created NOLOGIN: login and password are set out of band on each remote database
-- (docs/compliance/RELEASE_PROMOTION.md §2), never in the repository.
-- Idempotent: it can be run again (VAL-03).

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'iq_reader') then create role iq_reader nologin noinherit; end if;
end $$;

-- Audit chain verification without read access to the ledger: the definer (migration owner) reads it, the caller gets
-- only bigint|null.
create or replace function core.iq_audit_verify() returns bigint
language sql stable security definer set search_path = core, public as $$
  select core.audit_verify()
$$;
comment on function core.iq_audit_verify() is 'VAL-02: core.audit_verify() for the IQ role iq_reader, which cannot read core.audit_event';
revoke execute on function core.iq_audit_verify() from public;
grant execute on function core.iq_audit_verify() to iq_reader;

grant usage on schema core to iq_reader;
-- core.ddl_audit_active() is SECURITY INVOKER and reads pg_event_trigger, which every role can read.
grant execute on function core.ddl_audit_active() to iq_reader;

-- Migration ledger: created by the runners (scripts/db.mjs, scripts/db-remote.mjs) before the first migration, with RLS
-- on and no policy (db/supabase/0002). iq_reader gets select and a select-only policy limited to itself; anon and
-- authenticated still see nothing. Guarded so the migration also applies where the ledger does not exist.
do $$ begin
  if to_regclass('public.schema_migrations') is not null then
    grant usage on schema public to iq_reader;
    grant select on public.schema_migrations to iq_reader;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'schema_migrations' and policyname = 'iq_reader_read') then
      create policy iq_reader_read on public.schema_migrations for select to iq_reader using (true);
    end if;
  end if;
end $$;
