-- 0002_profiles_value_fields.sql
-- Free-text profile value fields backing the Profile > Edit form:
--   company_name, phone, location
--
-- These columns very likely ALREADY EXIST on public.profiles: the frontend
-- Profile type references them and the profile-edit page wrote them (indirectly)
-- before this migration. Every statement below is idempotent (ADD COLUMN IF NOT
-- EXISTS), so on a DB where the columns are already present this migration is a
-- no-op and safe to run.
--
-- RLS note: the Fastify backend talks to Supabase with the service-role key,
-- which bypasses RLS. Authorization (scoping every read/write to the
-- authenticated user_id, and whitelisting which profile fields a client may
-- set) is enforced in the backend service layer, not here.

alter table public.profiles add column if not exists company_name text;
alter table public.profiles add column if not exists phone        text;
alter table public.profiles add column if not exists location     text;

-- Verification-request fields the backend now sets server-side when a user
-- requests verification (the client must NOT set these itself). Included here
-- for completeness; they may also already exist.
alter table public.profiles add column if not exists verification_status       text default 'unverified';
alter table public.profiles add column if not exists verification_requested_at timestamptz;
