-- 0005_emergency_rls_hardening.sql
-- ============================================================================
-- EMERGENCY RLS HARDENING — apply before any real firm touches the platform.
--
-- Closes the anon/authenticated-reachable critical findings from the RLS audit.
-- The frontend ships the Supabase ANON KEY in the browser bundle, so every
-- policy below is directly reachable from a hostile client via PostgREST.
--
-- WHY COLUMN-LEVEL REVOKE AND NOT `WITH CHECK`:
--   A Postgres RLS `WITH CHECK` expression sees only the NEW row — it cannot
--   reference the OLD value, so "is_admin must stay what it was" is not
--   expressible as a policy predicate. Column-level REVOKE is the correct
--   instrument. `service_role` keeps its grants, so the Fastify backend
--   (service-role key) is unaffected and remains the only writer for these
--   columns.
--
-- IDEMPOTENT: safe to re-run. Column REVOKEs are guarded on column existence
-- so this applies cleanly regardless of which optional migrations have run.
-- ============================================================================


-- ── F-1 (CRITICAL): self-grant of platform admin ────────────────────────────
-- `003_profiles_and_chat.sql:72` creates:
--     CREATE POLICY "Users can update own profile" ON profiles
--       FOR UPDATE USING (auth.uid() = id);
-- With no WITH CHECK, the USING clause is reused — it constrains WHICH ROW may
-- be written, never WHICH COLUMNS. So any authenticated user could run
--     update profiles set is_admin = true where id = auth.uid()
-- and thereby satisfy is_platform_admin() (013:265-274) — unlocking every
-- admin RLS policy in 013/016/017 (all firms' beneficial owners, DOB,
-- nationality, sanctions screening, interview scoresheets, application-docs)
-- AND the backend's requireAdmin (src/middleware/requireAdmin.ts:10-14).
--
-- Users keep write access to genuinely self-service fields (full_name, bio,
-- phone, location, avatar_url, company_name, role). Only privilege- and
-- trust-bearing columns move behind the backend.
do $$
declare
  col text;
  privileged text[] := array[
    'is_admin',              -- platform admin flag  → is_platform_admin()
    'member_status',         -- invite/vetting gate  → Frontend/middleware.ts
    'member_tier',
    'verification_status',   -- "verified" trust signal
    'verification_requested_at',
    'trust_score'            -- core anti-fraud primitive; must never be self-set
  ];
begin
  foreach col in array privileged loop
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles'
         and column_name = col
    ) then
      -- UPDATE: blocks  update profiles set is_admin = true where id = auth.uid()
      execute format(
        'revoke update (%I) on public.profiles from anon, authenticated', col
      );
      -- INSERT: the profile row is created CLIENT-SIDE at sign-up
      -- (Frontend/app/sign-up/page.tsx:82), and 003:73's INSERT policy
      -- `WITH CHECK (auth.uid() = id)` likewise constrains only the row, not the
      -- columns. Without this, an attacker self-registers WITH is_admin = true
      -- and walks straight past the UPDATE revoke above.
      -- Column-level INSERT privilege only applies to explicitly-named columns,
      -- so a normal sign-up that omits these still succeeds and takes the
      -- column defaults (is_admin FALSE, verification_status 'unverified').
      execute format(
        'revoke insert (%I) on public.profiles from anon, authenticated', col
      );
      raise notice 'revoked UPDATE(%) and INSERT(%) on profiles from anon, authenticated', col, col;
    end if;
  end loop;
end $$;


-- ── F-2 (CRITICAL): free, unlimited reward redemption ───────────────────────
-- `007_loyalty_rewards.sql:107-108` grants clients a direct INSERT:
--     CREATE POLICY "Users can redeem rewards" ON reward_redemptions
--       FOR INSERT WITH CHECK (auth.uid() = user_id);
-- The policy checks WHO, never whether they can afford it or hold the required
-- tier, and points_spent is attacker-supplied. Frontend/lib/supabase/loyalty.ts
-- :168 performs exactly this insert from the browser.
--
-- This is a live bypass of migration 0003's atomic redeem_reward() — that
-- function correctly revokes itself from anon/authenticated, but is moot while
-- the RLS INSERT path remains open. Loyalty points redeem for real services
-- (inspections, storage credits, vessel charter), so this is revenue leakage.
--
-- Redemption must go through the backend: POST /api/loyalty/rewards/:id/redeem
--
-- NOTE ON GUARDS: `REVOKE` has no IF EXISTS form, and `DROP POLICY IF EXISTS`
-- still requires the TABLE to exist. Both raise 42P01 on a missing object and
-- abort the whole script. Every such statement in this file is therefore wrapped
-- in a to_regclass() check so the migration applies cleanly against a database
-- that is missing some optional tables — which this one is.
do $$
begin
  if to_regclass('public.reward_redemptions') is not null then
    execute 'revoke insert on public.reward_redemptions from anon, authenticated';
    -- Drop the permissive policy outright so intent is unambiguous even if
    -- grants are later restored by a default-privileges change.
    execute 'drop policy if exists "Users can redeem rewards" on public.reward_redemptions';
    raise notice 'reward_redemptions: client INSERT revoked, permissive policy dropped';
  else
    raise warning 'reward_redemptions NOT FOUND — free-redemption hole NOT closed. Investigate.';
  end if;
end $$;


-- ── F-12 (CRITICAL): backup table with real deal data and NO RLS ────────────
-- `011_fix_deals_schema.sql:5-6` created deals_backup_20260421 via
-- CREATE TABLE ... AS SELECT * FROM deals, with no ENABLE ROW LEVEL SECURITY,
-- no policies and no REVOKE. Under Supabase's stock default privileges
-- (GRANT ALL ON TABLES TO anon, authenticated) that is anon-readable AND
-- anon-writable: buyer_name, seller_name, total_value, price_per_unit, notes.
--
-- Verified 2026-08-01 against the dev database: 3 rows, matching the "3 dev
-- rows" note at 011:198. Dropped rather than protected — there is nothing here
-- worth keeping, and a dropped table cannot leak.
drop table if exists public.deals_backup_20260421;


-- ── F-13 (CRITICAL): notification_preferences has no RLS ────────────────────
-- migrations/0001_notification_preferences.sql:9-13 deliberately skips RLS,
-- reasoning that "clients don't have direct access." They do — the anon key is
-- in the browser bundle. Enable RLS and revoke; the backend (service_role)
-- bypasses RLS and continues to work unchanged.
-- Deliberately NO policy is created: with RLS on and no policy, all non-service
-- roles are denied. The backend is the only intended accessor.
--
-- This table may legitimately be absent: migrations/0001 was never applied to
-- some environments. It is also worth checking whether it exists in a NON-public
-- schema — PostgREST reported it present while `public.notification_preferences`
-- did not resolve, which is the signature of a table living in another exposed
-- schema. If so it is still client-reachable and still needs this treatment.
do $$
begin
  if to_regclass('public.notification_preferences') is not null then
    execute 'alter table public.notification_preferences enable row level security';
    execute 'revoke all on public.notification_preferences from anon, authenticated';
    raise notice 'notification_preferences: RLS enabled, client grants revoked';
  else
    raise warning 'public.notification_preferences NOT FOUND — skipped. If PostgREST can still reach a table by this name it lives in another schema and is UNPROTECTED; run the schema diagnostic.';
  end if;
end $$;


-- ── F-14 (CRITICAL): admin_application_queue view bypasses RLS ──────────────
-- `015_approval.sql:71-101` defines this view over organizations,
-- beneficial_owners, screening_results and verification_checks without
-- security_invoker. A view runs with its OWNER's privileges, so it bypasses RLS
-- on every underlying table — exposing every applicant firm's legal name,
-- jurisdiction, status, blacklist_flag and screening_flag.
-- Belt and braces: on PG15+ also make the view honour the *caller's* RLS, so
-- even if grants are restored the underlying policies still apply.
do $$
begin
  if to_regclass('public.admin_application_queue') is null then
    raise warning 'admin_application_queue NOT FOUND — skipped';
    return;
  end if;

  execute 'revoke all on public.admin_application_queue from anon, authenticated';
  raise notice 'admin_application_queue: client grants revoked';

  if current_setting('server_version_num')::int >= 150000 then
    execute 'alter view public.admin_application_queue set (security_invoker = on)';
    raise notice 'admin_application_queue: security_invoker enabled';
  else
    raise notice 'PG < 15: security_invoker unavailable; relying on REVOKE only';
  end if;
end $$;


-- ── F-3 (CRITICAL): self-promotion provisional → full ───────────────────────
-- promote_to_full (016:70-126) and approve_organization (015:11-63) are
-- SECURITY DEFINER with no REVOKE. Postgres defaults functions to
-- EXECUTE TO PUBLIC, which makes them callable PostgREST RPC endpoints
-- (POST /rest/v1/rpc/promote_to_full).
--
-- promote_to_full's preconditions are self-satisfiable by a member:
--   * onboarding_progress.completed_at — onboarding_upsert (016:161-163) is
--     FOR ALL scoped only by org_id, so a member writes their own completed_at
--   * verified financial_capacity — capacity_insert (016:153-154) constrains
--     only org_id; verification_status/verified_by/verified_at/amount are all
--     attacker-supplied on INSERT (only UPDATE is admin-gated)
--   * the closed-deal requirement is skippable via any non-empty
--     p_override_reason (016:112-114)
-- 'full' is what org_status_permits() (017:207-222) gates deal.* on.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('promote_to_full', 'approve_organization')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
    raise notice 'locked down %', fn.sig;
  end loop;
end $$;

-- Close the INSERT hole that made the promotion precondition self-satisfiable:
-- a client may still declare capacity, but never mark it verified.
do $$
begin
  if to_regclass('public.financial_capacity') is not null then
    -- DROP POLICY IF EXISTS still needs the TABLE to exist, so it lives in here.
    execute 'drop policy if exists capacity_insert on public.financial_capacity';
    execute $p$
      create policy capacity_insert on public.financial_capacity
        for insert to authenticated
        with check (
          org_id = public.current_org_id()
          and coalesce(verification_status, 'pending') = 'pending'
          and verified_by is null
          and verified_at is null
        )
    $p$;
    raise notice 'financial_capacity INSERT now forces verification_status=pending';
  end if;
end $$;


-- ── Verification queries (run these after applying) ─────────────────────────
-- Expect ZERO rows from each:
--
--   -- F-1: no privileged column writable by clients
--   select grantee, privilege_type, column_name
--     from information_schema.column_privileges
--    where table_name='profiles' and privilege_type='UPDATE'
--      and grantee in ('anon','authenticated')
--      and column_name in ('is_admin','member_status','verification_status','trust_score');
--
--   -- F-2: no client INSERT on redemptions
--   select grantee, privilege_type from information_schema.table_privileges
--    where table_name='reward_redemptions' and grantee in ('anon','authenticated');
--
--   -- F-12: table gone
--   select to_regclass('public.deals_backup_20260421');   -- expect NULL
--
-- And confirm RLS is on:
--   select relname, relrowsecurity from pg_class
--    where relname in ('notification_preferences','profiles','reward_redemptions');
