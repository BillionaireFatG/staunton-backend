-- 0015_deals_write_lockdown.sql
-- ============================================================================
-- 🚨 FINANCIAL — CLOSES DEALS MASS-ASSIGNMENT / REPRICE (F-4, F-5).
--
-- ── The hole ────────────────────────────────────────────────────────────────
-- 011_fix_deals_schema.sql gives clients direct write policies on `deals`:
--
--   INSERT: WITH CHECK (auth.uid() = created_by)
--     — pins only the creator. A member can fabricate a deal naming ANOTHER
--       firm as buyer/seller, and preset status/progress on the way in.
--
--   UPDATE: USING (buyer/seller/created_by = auth.uid())  -- NO WITH CHECK
--     — a Postgres UPDATE policy with no WITH CHECK reuses USING, which
--       constrains which ROW may be written, never which COLUMNS. So a party can
--       rewrite unit_price (reprice), quantity, flip status to 'completed', forge
--       reference_number, tamper progress_percentage, or swap seller_id/buyer_id.
--       progress_percentage is the figure a counterparty/lender reads (MASTER
--       §3) and must be server-derived — it must never be client-writable.
--
-- ── The fix: no client writes to the deal spine at all ──────────────────────
-- The backend already owns the entire deals write path through the service role
-- (services/deals.ts: createDeal pins buyer/seller/created_by and never accepts
-- status/total_value/reference_number/progress_percentage; updateDeal patches
-- only status/notes; POST/PATCH under /api/deals). The service role BYPASSES
-- RLS, so revoking every client write breaks nothing server-side and makes the
-- backend the single writer — the three-layer rule, not an exception to it.
--
-- This is a TABLE-level REVOKE against Supabase's table-level default grant,
-- which is effective (not the column-vs-table no-op of 0005). SELECT is left
-- intact, so deal lists, detail views and realtime subscriptions keep working;
-- only writes move behind the API.
--
-- ── FRONTEND COORDINATION (direct deal writes must reroute) ─────────────────
-- These stop working and must call the backend instead:
--   * Frontend/lib/supabase/deals.ts updateDeal()     -> PATCH /api/deals/:id
--   * Frontend/lib/supabase/deals.ts createDealEvent() -> POST  /api/deals/:id/events
-- Deal creation already goes through the backend (no direct client insert found).
-- Deal READS (dashboard lists, detail, realtime) are unaffected.
--
-- IDEMPOTENT: guarded on table existence; safe to re-run.
-- ============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'public.deals is missing — cannot lock a table that is not there';
  end if;
  raise notice 'preflight OK: public.deals present';
end $$;


-- ── deals: revoke every client write, drop the permissive write policies ─────
do $$
begin
  -- Table-level revoke kills the reprice/mass-assignment path for both roles.
  execute 'revoke insert, update, delete on public.deals from anon, authenticated';

  -- Drop the permissive policies so the intent is explicit even if a later
  -- default-privileges change restores grants. The SELECT policy
  -- ("Users can view own deals") is KEPT — reads stay client-side.
  execute 'drop policy if exists "Users can create deals" on public.deals';
  execute 'drop policy if exists "Users can update own deals" on public.deals';

  raise notice 'deals: client INSERT/UPDATE/DELETE revoked; write policies dropped; SELECT retained';
end $$;


-- ── deal_events: same posture (events are written by the backend) ────────────
-- 011's event INSERT policy only pinned created_by, so a member could also forge
-- audit events onto deals they are not party to. Backend writes events via
-- POST /api/deals/:id/events after an access check. Revoke client writes; keep
-- SELECT (parties read the timeline, incl. via realtime).
do $$
begin
  if to_regclass('public.deal_events') is not null then
    execute 'revoke insert, update, delete on public.deal_events from anon, authenticated';
    execute 'drop policy if exists "Users can create deal events" on public.deal_events';
    raise notice 'deal_events: client writes revoked; SELECT retained';
  else
    raise warning 'public.deal_events NOT FOUND — skipped';
  end if;
end $$;


-- ── inspections: defense-in-depth (no client write path exists today) ────────
-- inspections has only a SELECT policy, so RLS already denies client writes, but
-- revoke the table-level grant too so a future stray policy cannot reopen it.
do $$
begin
  if to_regclass('public.inspections') is not null then
    execute 'revoke insert, update, delete on public.inspections from anon, authenticated';
    raise notice 'inspections: client writes revoked (defense-in-depth)';
  else
    raise warning 'public.inspections NOT FOUND — skipped';
  end if;
end $$;


-- ============================================================================
-- VERIFICATION — run after applying, or `npm run verify:deals`.
-- ============================================================================
-- With a REAL authenticated party token (a buyer/seller on the deal):
--
-- 1. Reprice is refused. Expect 42501 (and the stored unit_price unchanged):
--
--      PATCH /rest/v1/deals?id=eq.<dealId>  {"unit_price": 1}
--      PATCH /rest/v1/deals?id=eq.<dealId>  {"status": "completed"}
--      PATCH /rest/v1/deals?id=eq.<dealId>  {"reference_number": "STN-FORGED"}
--
-- 2. Fabricating a deal is refused. Expect 42501:
--
--      POST  /rest/v1/deals  {buyer_id:<self>, seller_id:<other>, ...}
--
-- 3. The backend service write still works (service role bypasses RLS):
--
--      services/deals.ts createDeal(...) / updateDeal(...)  -> succeeds
--
-- 4. Reads are unaffected — a party still SELECTs their own deals:
--
--      GET /rest/v1/deals?select=id,unit_price  (party JWT) -> the party's rows
--
-- 5. No lingering client write grants. Expect ZERO rows:
--
--      select grantee, privilege_type from information_schema.table_privileges
--       where table_schema='public' and table_name='deals'
--         and grantee in ('anon','authenticated')
--         and privilege_type in ('INSERT','UPDATE','DELETE');
-- ============================================================================
