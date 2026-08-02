-- 0008_fix_redeem_ambiguous_column.sql
-- ============================================================================
-- Fixes the second defect in redeem_reward(), found by
-- `npm run verify:redemption` after 0007 restored the tier gate.
--
-- SYMPTOM
--   column reference "available_points" is ambiguous
--   All redemptions failed. In the concurrency test, 0 of 6 succeeded where
--   exactly 1 should have.
--
-- CAUSE
--   The function's RETURNS TABLE (...) declares an OUT column named
--   `available_points`. In PL/pgSQL, OUT columns are in scope as variables for
--   the whole body. `public.user_loyalty` also has a column `available_points`.
--   So in
--       update public.user_loyalty
--          set available_points = available_points - v_reward.points_cost
--        where available_points >= v_reward.points_cost
--       returning available_points into v_new_bal;
--   every unqualified reference is ambiguous between the OUT variable and the
--   table column, and PostgreSQL refuses rather than guessing (42702).
--
--   This is the standard RETURNS TABLE / column-name collision trap. It did not
--   surface until 0007 fixed the enum cast, because the tier gate raised first
--   and execution never reached the UPDATE.
--
-- SEVERITY
--   Failed CLOSED again. Harness confirmed: succeeded=0/6, charged=0,
--   redemption rows == successes, balance non-negative. No double-spend was
--   ever reachable. This restores function.
--
-- FIX
--   Qualify every reference to the table's column as `user_loyalty.<col>`.
--   Note the SET target must stay unqualified — SQL forbids qualifying the
--   left-hand side of SET — but its value expression, the WHERE clause and
--   RETURNING are all qualified, which is what resolves the ambiguity.
--
-- IDEMPOTENT: create or replace; safe to re-run.
-- Depends on 0003 and 0007.
-- ============================================================================

do $$
begin
  if to_regprocedure('public.redeem_reward(uuid,uuid)') is null then
    raise exception 'PREFLIGHT FAILED: redeem_reward(uuid,uuid) not found. Apply 0003 then 0007 first.';
  end if;
  if to_regprocedure('public.loyalty_tier_rank(text)') is null then
    raise exception 'PREFLIGHT FAILED: loyalty_tier_rank(text) not found. Apply 0003 first.';
  end if;
end $$;


create or replace function public.redeem_reward(
  p_user_id   uuid,
  p_reward_id uuid
)
returns table (
  status           text,
  redemption_id    uuid,
  points_spent     int,
  available_points int,
  required_tier    text,
  user_tier        text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reward     public.rewards%rowtype;
  v_lifetime   int;
  v_user_tier  text;
  v_new_bal    int;
  v_redemption uuid;
begin
  select * into v_reward from public.rewards where id = p_reward_id;
  if not found then
    return query select 'reward_not_found'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  if not coalesce(v_reward.is_active, false) then
    return query select 'reward_inactive'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  if v_reward.expires_at is not null and v_reward.expires_at < now() then
    return query select 'reward_expired'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  -- Row lock. Serializes concurrent redemptions for this user; the loser
  -- re-reads the already-decremented balance and is rejected below.
  select ul.lifetime_points into v_lifetime
    from public.user_loyalty ul
   where ul.user_id = p_user_id
     for update;

  if not found then
    return query select 'loyalty_not_found'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  v_user_tier := public.loyalty_tier_for_points(v_lifetime);

  -- Tier gate, enforced in the WRITE path (0007 fixed the enum cast here).
  if public.loyalty_tier_rank(v_user_tier) < public.loyalty_tier_rank(v_reward.tier_required::text) then
    return query select 'tier_too_low'::text, null::uuid, null::int, null::int,
                        v_reward.tier_required::text, v_user_tier::text;
    return;
  end if;

  if v_reward.quantity_available is not null and v_reward.quantity_available <= 0 then
    return query select 'out_of_stock'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  -- FIX: qualify the table's column everywhere it is READ, so it cannot be
  -- confused with the OUT variable of the same name. The SET target itself must
  -- remain unqualified — SQL does not allow a qualified name on the left of '='.
  -- The WHERE clause is still the real guard: a short balance updates zero rows.
  update public.user_loyalty
     set available_points = public.user_loyalty.available_points - v_reward.points_cost,
         updated_at       = now()
   where public.user_loyalty.user_id = p_user_id
     and public.user_loyalty.available_points >= v_reward.points_cost
  returning public.user_loyalty.available_points into v_new_bal;

  if not found then
    return query select 'insufficient_points'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  insert into public.reward_redemptions (user_id, reward_id, points_spent, status)
  values (p_user_id, p_reward_id, v_reward.points_cost, 'pending')
  returning id into v_redemption;

  if v_reward.quantity_available is not null then
    update public.rewards r
       set quantity_available = r.quantity_available - 1
     where r.id = p_reward_id
       and r.quantity_available > 0;
    if not found then
      raise exception 'reward % went out of stock during redemption', p_reward_id
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.loyalty_transactions
    (user_id, points, transaction_type, description, reference_id, reference_type)
  values
    (p_user_id, -v_reward.points_cost, 'redeemed', 'Redeemed — ' || v_reward.name, v_redemption, 'reward');

  return query select 'ok'::text, v_redemption, v_reward.points_cost, v_new_bal,
                      v_reward.tier_required::text, v_user_tier::text;
end;
$$;


-- ── Grants (CREATE OR REPLACE does not preserve them) ──────────────────────
revoke all on function public.redeem_reward(uuid, uuid) from public, anon, authenticated;
grant execute on function public.redeem_reward(uuid, uuid) to service_role;

-- Verify after applying:
--   npm run seed:loyalty && npm run verify:redemption
-- Expect ALL checks to pass: tier gate returns 'tier_too_low', and exactly
-- 1 of 6 concurrent redemptions succeeds charging exactly one reward cost.
