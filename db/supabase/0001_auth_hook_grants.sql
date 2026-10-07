-- Supabase only (not applied to the local embedded PostgreSQL): lets Supabase Auth call the claims hook of 0007/0008.
-- docs/supabase.md step 3. The hook is then enabled in the Auth config (Management API or dashboard).
grant usage on schema core to supabase_auth_admin;
grant execute on function core.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant select on core.person, core.role_assignment to supabase_auth_admin;
-- RLS is enabled on role_assignment? No (0003/0006): person and role_assignment have no RLS, so a plain grant suffices.
