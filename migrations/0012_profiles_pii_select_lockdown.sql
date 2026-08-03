-- 0012_profiles_pii_select_lockdown.sql
-- ============================================================================
-- 🚨 CRITICAL — CLOSES THE LIVE PROFILES PII LEAK (worst finding this pass).
--
-- Apply this FIRST of the 0012–0016 batch.
--
-- ── The hole (reproduced live, 2026-08-02) ──────────────────────────────────
-- 003_profiles_and_chat.sql:71 creates:
--     CREATE POLICY "Public profiles are viewable by everyone"
--       ON profiles FOR SELECT USING (true);
-- With Supabase's stock table-level GRANT SELECT to anon, that makes the ENTIRE
-- member directory readable by anyone holding the browser-shipped anon key. An
-- unauthenticated PostgREST call returned real members' email and company:
--     GET /rest/v1/profiles?select=email,company_name
--       -> 200 [{"email":"amita@bhooma.ca","company_name":"ZMH Global"}, ...]
-- On an invite-only platform whose premise is that you do NOT get to see who
-- else is on it, the member list + emails + phones are the sensitive asset, and
-- the anon key ships in the frontend bundle. email, phone and is_admin were all
-- anon-readable.
--
-- ── The two-tier model this installs ────────────────────────────────────────
-- RLS is row-level, not column-level, so "own full row + a subset of others"
-- cannot be one policy. It is two objects:
--
--   1. profiles (base table) SELECT is restricted to:
--        * the caller's OWN row (all columns, incl. email/phone/member_status),
--        * plus platform admins (is_platform_admin()), who administer the base.
--      anon loses SELECT entirely. A non-admin member can no longer read another
--      member's row from the base table at all — so email/phone of others is
--      unreachable here.
--
--   2. public_profiles (view) exposes only the NON-SENSITIVE subset
--        id, full_name, company_name, avatar_url, verification_status, role, bio,
--        created_at  — and is granted to `authenticated` only (never anon).
--      This is the member-to-member directory surface: names and companies, no
--      email, no phone, no location, no is_admin, no member_status.
--
-- Result: anon -> nothing; member -> own full row + others' safe subset;
-- member CANNOT read another member's email; admin -> full base access.
--
-- ── FRONTEND COORDINATION (blocked reads must reroute) ──────────────────────
-- The backend (service_role) BYPASSES RLS, so nothing in services/*.ts changes.
-- The DIRECT client reads below stop working and must route through the backend
-- (GET /api/profiles/:id, GET /api/profiles/search) or read public_profiles:
--   * middleware.ts own-row read (member_status,full_name where id=auth.uid())
--       -> STILL WORKS (own row). Sign-in is NOT broken.
--   * components/GlobalSearch.tsx  (cross-member profiles read)  -> BLOCKED
--   * app/profile/[userId]/page.tsx (select('*') of another member) -> BLOCKED
--       (also previously leaked email/phone/is_admin to any member; now gone)
--   * lib/supabase/deals.ts counterparty name join              -> BLOCKED
--   * lib/supabase/master-helpers.ts cross-member reads         -> BLOCKED
-- Each blocked read should use public_profiles (subset) or the backend.
--
-- IDEMPOTENT: guarded on object existence, safe to re-run.
-- ============================================================================


-- ── Preflight ───────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles is missing — nothing to lock and something is very wrong';
  end if;
  raise notice 'preflight OK: public.profiles present';
end $$;


-- ============================================================================
-- PART A — RESTRICT profiles BASE-TABLE SELECT (own row + admin), REVOKE anon
-- ============================================================================
do $$
declare
  has_admin_fn boolean := to_regprocedure('public.is_platform_admin()') is not null;
  using_expr   text;
begin
  -- Drop the permissive "everyone" policy outright so intent is unambiguous even
  -- if a later default-privileges change restores grants.
  execute 'drop policy if exists "Public profiles are viewable by everyone" on public.profiles';
  execute 'drop policy if exists profiles_select_own_or_admin on public.profiles';

  -- Own row always; platform admins additionally see every row so the admin
  -- vetting surfaces keep working with a real session (they also use the
  -- service role, which bypasses RLS, so this is belt-and-braces). Wrapped in
  -- (select auth.uid()) so the planner evaluates it once per query.
  if has_admin_fn then
    using_expr := '(id = (select auth.uid())) or public.is_platform_admin()';
    raise notice 'is_platform_admin() present — admins retain full base-table read';
  else
    -- Fail closed: if the helper is absent, restrict to own row rather than
    -- silently widening. Admin base reads then rely on the service role only.
    using_expr := '(id = (select auth.uid()))';
    raise warning 'is_platform_admin() NOT found — SELECT restricted to own row only; admin session reads will rely on the service role';
  end if;

  execute format(
    'create policy profiles_select_own_or_admin on public.profiles for select to authenticated using (%s)',
    using_expr
  );

  -- Kill anon SELECT at the TABLE level. This is a table-level REVOKE against a
  -- table-level grant, which (unlike a bare column REVOKE — see 0005/0010) is
  -- NOT a no-op. anon keeps no read path to profiles at all.
  execute 'revoke select on public.profiles from anon';
  -- 0010 already revoked anon insert/update/delete; restate for a clean posture.
  execute 'revoke insert, update, delete on public.profiles from anon';

  raise notice 'profiles: base SELECT restricted to own-row + admin; anon SELECT revoked';
end $$;


-- ============================================================================
-- PART B — public_profiles: the member-to-member NON-SENSITIVE subset
-- ============================================================================
-- Deliberately excludes email, phone, location, is_admin, verified_at,
-- verification_requested_at, member_status, member_tier. A plain (non
-- security_invoker) view runs with its owner's privileges, so it can project a
-- safe subset across all rows without re-granting base-table access to members.
-- It is exposed to `authenticated` only; anon is revoked explicitly because
-- Supabase's default privileges can otherwise grant new objects to anon.
create or replace view public.public_profiles as
  select
    id,
    full_name,
    company_name,
    avatar_url,
    verification_status,
    role,
    bio,
    created_at
  from public.profiles;

do $$
begin
  -- Force owner-privilege semantics explicitly (default is off on PG15+, but be
  -- explicit so a project-level default flip cannot turn this into an own-row
  -- view that returns nothing useful to members).
  if current_setting('server_version_num')::int >= 150000 then
    execute 'alter view public.public_profiles set (security_invoker = off)';
  end if;

  -- Lock the grant surface: authenticated only.
  execute 'revoke all on public.public_profiles from public, anon';
  execute 'grant select on public.public_profiles to authenticated';

  raise notice 'public_profiles: safe subset view; authenticated-only, anon revoked';
end $$;

comment on view public.public_profiles is
  'Member-to-member directory subset of profiles: id, full_name, company_name, avatar_url, verification_status, role, bio, created_at. NO email/phone/location/is_admin/member_status. authenticated-only; anon revoked. Owner-privilege (security_invoker off) so it projects across rows while the base table stays own-row+admin.';


-- ============================================================================
-- VERIFICATION — run after applying, or `npm run verify:profiles`.
-- ============================================================================
-- Live proof (browser publishable key = anon):
--
-- 1. anon can no longer read ANY profile. Expect 42501 / permission denied:
--
--      curl -s "$SUPABASE_URL/rest/v1/profiles?select=email&limit=1" \
--           -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
--
-- 2. A real member reads their OWN full row (email present). Expect 1 row:
--
--      GET /rest/v1/profiles?select=email,member_status&id=eq.<self>   (member JWT)
--
-- 3. A real member reads ANOTHER member's row from the base table. Expect 0 rows
--    (RLS filters it — the email is unreachable):
--
--      GET /rest/v1/profiles?select=email&id=eq.<other>                (member JWT)
--
-- 4. The same member reads the other's SUBSET via the view. Expect 1 row and NO
--    email column available:
--
--      GET /rest/v1/public_profiles?select=id,full_name,company_name&id=eq.<other>
--      GET /rest/v1/public_profiles?select=email   -> undefined column (not exposed)
--
-- 5. anon cannot read the view. Expect 42501:
--
--      GET /rest/v1/public_profiles?select=id&limit=1                  (anon key)
--
-- 6. A platform admin (is_admin=true) still reads every row from the base table.
-- ============================================================================
