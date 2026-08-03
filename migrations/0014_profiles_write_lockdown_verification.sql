-- 0014_profiles_write_lockdown_verification.sql
-- ============================================================================
-- LOCKS THE SELF-SETTABLE "VERIFIED" FLAG (and the membership gate columns).
--
-- Supersedes 0010's writable-column allowlist on public.profiles. Apply AFTER
-- 0010 and 0013.
--
-- ── The hole ────────────────────────────────────────────────────────────────
-- 0010 correctly dropped table-level INSERT/UPDATE on profiles and re-granted a
-- narrow set of self-service columns — but it DELIBERATELY left
-- verification_status and verification_requested_at writable, because
-- Frontend/lib/supabase/master-helpers.ts:272-278 sets verification_status
-- ='pending' directly from the browser (requestVerification). The consequence:
-- any member can PATCH their own verification_status to 'verified' in one call:
--     PATCH /rest/v1/profiles?id=eq.<self>  {"verification_status":"verified"}
-- and seven UI sites render a "Verified" badge off exactly that column. A
-- self-settable trust flag on an anti-fraud platform is the same class of hole
-- as the self-grant of is_admin — it just grants a cheaper lie.
--
-- The backend already owns the legitimate path: POST /api/profiles/me/verify
-- (services/profiles.ts requestVerification) sets verification_status='pending'
-- server-side. So the browser write is redundant as well as dangerous.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- Re-establish the profiles write surface with the FINAL locked set. The
-- instrument is the only one that works against Supabase's table-level default
-- grants (see 0005 -> 0010, and tests/migration-column-privileges.test.ts):
--     revoke insert, update on profiles from anon, authenticated;  -- table level
--     grant  insert (safe cols) on profiles to authenticated;      -- re-grant
--     grant  update (safe cols) on profiles to authenticated;
--
-- Columns NOT re-granted (i.e. now service-role / admin only):
--     is_admin                     -- platform admin flag (already locked, 0010)
--     verified_at                  -- the real "verified" timestamp (0010)
--     verification_status          -- NEWLY locked here
--     verification_requested_at    -- NEWLY locked here
--     member_status                -- access gate (0013) — approved == access
--     member_tier                  -- set on approval
--
-- ── FRONTEND COORDINATION ───────────────────────────────────────────────────
-- After this, Frontend/lib/supabase/master-helpers.ts requestVerification's
-- direct profiles write will 42501. It must call POST /api/profiles/me/verify
-- instead (already implemented). This is the follow-up 0010 flagged.
--
-- IDEMPOTENT: writable list is intersected with the live columns, so it can
-- never grant a column that is absent; safe to re-run.
-- ============================================================================

do $$
declare
  -- Every column a client may legitimately self-serve. Anything NOT here becomes
  -- unwritable by anon/authenticated. Built from the live column list so a
  -- missing column cannot be granted.
  writable text[] := array[
    'id',                 -- sign-up / onboarding upsert key
    'email',
    'full_name',
    'company_name',
    'role',
    'bio',
    'phone',
    'location',
    'avatar_url',
    'created_at',
    'updated_at'
    -- NOT: is_admin, verified_at, verification_status, verification_requested_at,
    --      member_status, member_tier  (privilege/trust/gate columns)
  ];
  present  text[];
  col_list text;
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles is missing';
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

  -- Drop table-level privileges first (this is what makes the column re-grant
  -- effective rather than a no-op), then re-grant only the safe columns.
  execute 'revoke update on public.profiles from anon, authenticated';
  execute format('grant update (%s) on public.profiles to authenticated', col_list);

  execute 'revoke insert on public.profiles from anon, authenticated';
  execute format('grant insert (%s) on public.profiles to authenticated', col_list);

  -- anon writes nothing to profiles.
  execute 'revoke insert, update, delete on public.profiles from anon';

  raise notice 'profiles: write surface re-granted on % (verification_status, member_status, member_tier, is_admin, verified_at all now LOCKED)', col_list;
end $$;


-- ============================================================================
-- VERIFICATION — run after applying, or `npm run verify:profiles`.
-- ============================================================================
-- 1. The locked columns must be ABSENT from client INSERT/UPDATE privileges.
--    Expect NO rows for is_admin, verified_at, verification_status,
--    verification_requested_at, member_status, member_tier:
--
--      select grantee, privilege_type, column_name
--        from information_schema.column_privileges
--       where table_schema='public' and table_name='profiles'
--         and grantee in ('anon','authenticated')
--         and privilege_type in ('INSERT','UPDATE')
--         and column_name in ('is_admin','verified_at','verification_status',
--                             'verification_requested_at','member_status','member_tier');
--
-- 2. No lingering TABLE-level INSERT/UPDATE for clients. Expect ZERO rows:
--
--      select grantee, privilege_type from information_schema.table_privileges
--       where table_schema='public' and table_name='profiles'
--         and grantee in ('anon','authenticated')
--         and privilege_type in ('INSERT','UPDATE');
--
-- 3. Live proof — a real member self-verifies. Expect 42501:
--
--      PATCH /rest/v1/profiles?id=eq.<self>  {"verification_status":"verified"} (member JWT)
--
-- 4. A legitimate self-service edit still works. Expect 200 (member JWT):
--
--      PATCH /rest/v1/profiles?id=eq.<self>  {"bio":"hello"}
-- ============================================================================
