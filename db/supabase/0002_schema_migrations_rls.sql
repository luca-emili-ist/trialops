-- Supabase only: the migration ledger lives in public, so PostgREST exposed it to the anon key (Security Advisor
-- rls_disabled_in_public, 2026-10-18). RLS on with no policy: anon/authenticated see nothing; the runners connect
-- as postgres (table owner, bypasses RLS) and keep working. Idempotent.
alter table public.schema_migrations enable row level security;
