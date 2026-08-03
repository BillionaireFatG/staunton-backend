-- 0013_profiles_membership_columns.sql
-- ============================================================================
-- THE AUTH GATE'S BACKEND HALF — profiles.member_status / profiles.member_tier.
--
-- ── Why ─────────────────────────────────────────────────────────────────────
-- Frontend/middleware.ts gates /dashboard on `profiles.member_status`, but the
-- LIVE profiles table has no such column (confirmed via PostgREST 2026-08-02:
-- the deployed columns are id, email, full_name, company_name, role,
-- verification_status, verification_requested_at, verified_at, bio, phone,
-- location, avatar_url, is_admin, created_at, updated_at). 012_membership.sql in
-- the frontend repo defined these columns but was never applied. With the column
-- absent, the middleware's `select member_status, full_name` errors, and the
-- whole gate is running on a value that does not exist.
--
-- This adds the columns the gate needs, matching 012_membership.sql exactly so
-- the two histories do not diverge.
--
-- ── Values (the frontend contract — types/profile.ts + middleware.ts) ────────
--   member_status : text, NOT NULL, default 'none'
--                   one of: none | invited | applied | in_review | approved
--                           | rejected | suspended
--                   Only 'approved' opens /dashboard; every other value redirects
--                   (none/invited -> /apply, applied/in_review -> /apply/pending,
--                    rejected -> /apply/rejected, suspended -> /suspended).
--   member_tier   : text, NULLABLE, default NULL
--                   one of: principal | direct_mandate   (set on approval)
--
-- ── Default 'none' is deliberate and safe ───────────────────────────────────
-- Existing rows become member_status='none'. That is NOT a downgrade: with the
-- column absent the middleware already treated everyone as 'none' (its
-- `?? 'none'` fallback). It DOES mean the gate is now real — a pilot member must
-- be moved to 'approved' (by an admin / the vetting flow) to reach /dashboard.
-- Fail-closed is the correct default for an access gate on an invite-only
-- platform: nobody is 'approved' until someone approves them.
--
-- ── NOT client-writable ─────────────────────────────────────────────────────
-- member_status / member_tier are privilege-bearing (approved == access). They
-- must be set only by the backend / admin, never self-set. They are locked in
-- 0014 (the profiles write-column lockdown), which revokes table-level
-- INSERT/UPDATE and re-grants only the self-service columns — this pair is not
-- in that list. Apply 0014 after this one.
--
-- IDEMPOTENT: add-column-if-not-exists + guarded constraints; safe to re-run.
-- ============================================================================

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles is missing';
  end if;

  alter table public.profiles
    add column if not exists member_status text not null default 'none';
  alter table public.profiles
    add column if not exists member_tier text;

  raise notice 'profiles: member_status (default none) and member_tier (nullable) present';
end $$;


-- CHECK constraints pin the enums at the database so a stray service-role write
-- cannot put a value the gate does not understand into the column that decides
-- access. Added NOT VALID-then-VALIDATE is unnecessary here because every
-- existing row is 'none' / NULL, which already satisfies both — but guard the
-- add so re-running is clean.
do $$
begin
  alter table public.profiles
    drop constraint if exists profiles_member_status_check;
  alter table public.profiles
    add constraint profiles_member_status_check
    check (member_status in ('none','invited','applied','in_review','approved','rejected','suspended'));

  alter table public.profiles
    drop constraint if exists profiles_member_tier_check;
  alter table public.profiles
    add constraint profiles_member_tier_check
    check (member_tier is null or member_tier in ('principal','direct_mandate'));

  raise notice 'profiles: member_status / member_tier CHECK constraints installed';
exception when others then
  raise warning 'could not install membership CHECK constraints: %', sqlerrm;
end $$;


-- ============================================================================
-- VERIFICATION — run after applying, or `npm run verify:profiles`.
-- ============================================================================
-- 1. Columns exist with the right defaults. Expect member_status='none' default,
--    member_tier nullable:
--
--      select column_name, data_type, is_nullable, column_default
--        from information_schema.columns
--       where table_schema='public' and table_name='profiles'
--         and column_name in ('member_status','member_tier');
--
-- 2. The gate value is present for a real member (own-row read, member JWT):
--
--      GET /rest/v1/profiles?select=member_status,member_tier&id=eq.<self>
--
-- 3. A member CANNOT self-approve (after 0014). Expect 42501:
--
--      PATCH /rest/v1/profiles?id=eq.<self>  {"member_status":"approved"}   (member JWT)
--
-- 4. The enum is enforced. Expect ERROR 23514 (check_violation):
--
--      update public.profiles set member_status='root' where id = (select id from public.profiles limit 1);
-- ============================================================================
