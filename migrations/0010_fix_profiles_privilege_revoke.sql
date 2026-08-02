-- 0010_fix_profiles_privilege_revoke.sql
-- ============================================================================
-- 🚨 CRITICAL — REPAIRS MIGRATION 0005's F-1 FIX, WHICH IS A NO-OP.
--
-- Apply this even if you apply nothing else in this batch.
--
-- ── The problem ─────────────────────────────────────────────────────────────
-- 0005_emergency_rls_hardening.sql closes F-1 (self-grant of platform admin)
-- with bare column-level REVOKEs:
--
--     revoke update (is_admin) on public.profiles from anon, authenticated;
--     revoke insert (is_admin) on public.profiles from anon, authenticated;
--
-- The reasoning in 0005 is correct — a WITH CHECK expression sees only the NEW
-- row and so cannot express "is_admin must stay what it was", which does make
-- column privileges the right instrument. The EXECUTION is not. From the
-- PostgreSQL REVOKE documentation:
--
--     "On the other hand, if a role has been granted privileges on a table,
--      then revoking the same privileges from individual columns will have no
--      effect."
--
-- Supabase's stock default privileges grant ALL on every table in `public` to
-- `anon` and `authenticated` — a TABLE-level grant. A column-level REVOKE
-- against a table-level grant does nothing at all. It does not error, it does
-- not warn, and 0005's `raise notice 'revoked UPDATE(%)...'` prints happily
-- either way, so the migration reports success while changing nothing.
--
-- Corroborating evidence that it is indeed inert: Frontend/app/sign-up/page.tsx
-- and app/auth/callback/route.ts both still write to `profiles` from the browser
-- on columns 0005 intended to revoke, and neither has been reported as broken.
--
-- If this is inert then F-1 is OPEN, and F-1 is total compromise:
--     update profiles set is_admin = true where id = auth.uid()
-- from the browser satisfies is_platform_admin() (013:265-274) and the backend's
-- own requireAdmin (src/middleware/requireAdmin.ts:10-14) — unlocking every
-- firm's beneficial owners, DOB, nationality, sanctions screening and interview
-- scoresheets, plus the whole admin vetting API.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- The only pattern that works against a table-level grant is to drop the
-- table-level privilege first and then re-grant the columns that must stay
-- writable:
--
--     revoke update on <table> from anon, authenticated;    -- kill table-level
--     grant  update (<safe cols>) on <table> to authenticated;
--
-- ── Scope: deliberately narrower than 0005 attempted ────────────────────────
-- This migration locks exactly TWO columns, and the restraint is the point —
-- a fix that breaks sign-up on a live invite-only platform will be reverted,
-- and then F-1 is open again.
--
--   * is_admin    — platform admin flag. Verified: NO client code writes it.
--                   Grepped Frontend/ for `is_admin:` as a write — every hit is
--                   a type declaration or a `.select()`. Safe to close now.
--   * verified_at — the actual "this firm is verified" trust signal. Verified:
--                   no client writes it; only the backend does.
--
-- NOT locked here, with reasons — see the follow-up section at the bottom:
--   * verification_status / verification_requested_at — Frontend
--     lib/supabase/master-helpers.ts:300-306 (requestVerification) writes both
--     from the browser. Locking them breaks the verification request flow.
--     They are a lesser risk: they can be set to 'pending', and 'verified' is
--     only meaningful in combination with verified_at, which IS locked here.
--   * member_status / member_tier / trust_score — 0005 lists all three. NONE OF
--     THEM EXISTS in the live `profiles` table (verified via PostgREST: the
--     deployed columns are id, email, full_name, company_name, role,
--     verification_status, verification_requested_at, verified_at, bio, phone,
--     location, avatar_url, is_admin, created_at, updated_at). Migration 012's
--     membership columns were never applied. So 0005's loop over those names
--     silently skipped them, and the frontend code writing `member_status`
--     (sign-up, auth/callback, invites/validate) has been failing against a
--     non-existent column. Flagged for the frontend team; nothing to lock here.
--
-- IDEMPOTENT: safe to re-run. Guarded on table and column existence.
-- ============================================================================

do $$
declare
  -- Every column a client may legitimately write. Built from the LIVE column
  -- list, intersected with what actually exists, so this cannot grant a
  -- privilege on a column that is not there.
  writable text[] := array[
    'id',                          -- sign-up / onboarding upsert key
    'email',
    'full_name',
    'company_name',
    'role',
    'bio',
    'phone',
    'location',
    'avatar_url',
    'verification_status',         -- see note above: NOT locked yet
    'verification_requested_at',   -- see note above: NOT locked yet
    'created_at',
    'updated_at'
  ];
  present text[];
  col_list text;
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles is missing — nothing to do, and something is very wrong';
  end if;

  select array_agg(quote_ident(c.column_name) order by c.column_name)
    into present
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = 'profiles'
     and c.column_name = any(writable);

  if present is null or array_length(present, 1) = 0 then
    raise exception 'no expected writable columns found on public.profiles — refusing to lock the table out';
  end if;

  col_list := array_to_string(present, ', ');

  -- ── UPDATE ───────────────────────────────────────────────────────────────
  -- Drop the table-level privilege (this is what 0005 omitted), then re-grant
  -- only the safe columns. is_admin and verified_at are simply not in the list,
  -- so they end up unwritable by any client.
  execute 'revoke update on public.profiles from anon, authenticated';
  execute format('grant update (%s) on public.profiles to authenticated', col_list);

  -- ── INSERT ───────────────────────────────────────────────────────────────
  -- Just as important as UPDATE: the profile row is created CLIENT-SIDE at
  -- sign-up (Frontend/app/sign-up/page.tsx:82) and 003's INSERT policy
  -- `WITH CHECK (auth.uid() = id)` constrains only the row, not the columns.
  -- Without this, an attacker self-registers WITH is_admin = true and walks
  -- straight past the UPDATE lockdown above.
  --
  -- A normal sign-up that omits these columns still succeeds — column-level
  -- INSERT privilege is only required for columns actually named in the
  -- statement; omitted ones take their defaults (is_admin FALSE).
  execute 'revoke insert on public.profiles from anon, authenticated';
  execute format('grant insert (%s) on public.profiles to authenticated', col_list);

  -- anon has no business writing profiles at all. Sign-up runs with a session
  -- (or fails for other reasons); the invite funnel goes through the backend.
  execute 'revoke insert, update, delete on public.profiles from anon';

  raise notice 'profiles: table-level INSERT/UPDATE dropped for clients; re-granted on %', col_list;
  raise notice 'profiles: is_admin and verified_at are now UNWRITABLE by anon and authenticated';
end $$;


-- ============================================================================
-- FOLLOW-UP REQUIRED (cross-layer — NOT done here, deliberately)
-- ============================================================================
-- Two further lockdowns are blocked on frontend changes. Doing them in this
-- migration would break live flows, so they are written down rather than
-- shipped half-applied.
--
-- 1. verification_status / verification_requested_at
--    Blocked by: Frontend/lib/supabase/master-helpers.ts:300-306, which sets
--    verification_status='pending' directly from the browser.
--    Remediation: move requestVerification behind the backend (it is a state
--    change on a trust signal, so it belongs there under master §7 anyway),
--    then drop these two from the `writable` array above and re-run.
--
-- 2. member_status
--    Blocked by: the column does not exist, AND three frontend call sites write
--    it (app/sign-up/page.tsx:82, app/auth/callback/route.ts:42,
--    app/api/invites/validate/route.ts:59). Those writes are currently FAILING
--    silently — sign-up ignores the returned error. So the membership gate that
--    Frontend/middleware.ts reads is not being set by the sign-up path at all.
--    This is a functional bug, not just a security one, and it belongs to the
--    frontend/membership work rather than to this migration.
--
-- ============================================================================
-- VERIFICATION — run after applying
-- ============================================================================
--
-- 1. The two locked columns must NOT appear. Expect is_admin and verified_at to
--    be ABSENT from these results (every other profiles column should appear):
--
--      select grantee, privilege_type, column_name
--        from information_schema.column_privileges
--       where table_schema='public' and table_name='profiles'
--         and grantee in ('anon','authenticated')
--         and privilege_type in ('INSERT','UPDATE')
--       order by grantee, privilege_type, column_name;
--
-- 2. No lingering TABLE-level INSERT/UPDATE for clients. Expect ZERO rows —
--    this is the check that would have caught the 0005 defect:
--
--      select grantee, privilege_type from information_schema.table_privileges
--       where table_schema='public' and table_name='profiles'
--         and grantee in ('anon','authenticated')
--         and privilege_type in ('INSERT','UPDATE');
--
-- 3. The live proof. As a REAL logged-in non-admin user (browser devtools
--    console on the app, where `supabase` is the anon-key client):
--
--      await supabase.from('profiles')
--        .update({ is_admin: true })
--        .eq('id', (await supabase.auth.getUser()).data.user.id)
--
--    BEFORE: succeeds (this is F-1).
--    AFTER : {code: '42501', message: 'permission denied for table profiles'}
--
--    Then confirm nothing legitimate broke: complete an onboarding profile save
--    and a sign-up. Both must still work.
-- ============================================================================
