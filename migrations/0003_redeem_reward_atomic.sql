-- 0003_redeem_reward_atomic.sql
-- ============================================================================
-- Atomic reward redemption. Closes two confirmed security bugs in
-- services/loyalty.ts `redeemReward`:
--
--   1. TIER GATE BYPASS. The redeem path never checked `rewards.tier_required`
--      (only the read path, getRewards(), gated by tier). A gold user could POST
--      directly to /api/loyalty/rewards/:id/redeem and redeem a platinum-only
--      reward. Reproduced: gold user redeemed "Free Inspection" (5000pts,
--      platinum) and was charged, returning 204.
--
--   2. DOUBLE-SPEND. The redeem path did a non-atomic read-then-write:
--      it read available_points, then wrote (available_points - cost). Six
--      concurrent redemptions of a 3000pt reward against an 8500 balance all
--      succeeded — 18,000pts of rewards granted, balance fell by only 3000
--      (last write wins). This CANNOT be fixed correctly in application code;
--      it has to be one atomic database operation.
--
-- The function below is the single supported redemption path. It takes a row
-- lock on the caller's loyalty row, re-validates every gate under that lock,
-- decrements conditionally, and writes the redemption + ledger rows in the SAME
-- transaction (a plpgsql function body is atomic). Concurrent callers serialize
-- on the lock; the loser sees the already-decremented balance and is rejected
-- with 'insufficient_points'.
--
-- ERROR SIGNALLING: this returns a `status` string rather than raising, so the
-- API layer maps outcomes to HTTP codes without depending on SQLSTATE plumbing
-- through PostgREST. Every write happens only after all checks pass, so an
-- early return never leaves partial state.
--
-- IDEMPOTENT: safe to re-run (create or replace + idempotent grants).
-- ============================================================================

-- Tier rank shared by the gate below. Keep in sync with TIER_THRESHOLDS in
-- src/services/loyalty.ts — the DB is authoritative for the SECURITY gate; the
-- TypeScript copy exists for display/progress only.
create or replace function public.loyalty_tier_rank(p_tier text)
returns int
language sql
immutable
as $$
  select case lower(p_tier)
    when 'bronze'   then 1
    when 'silver'   then 2
    when 'gold'     then 3
    when 'platinum' then 4
    when 'diamond'  then 5
    else 99  -- unknown tier ranks above diamond => fails closed (nobody qualifies)
  end;
$$;

-- Tier earned from cumulative lifetime points. Mirrors getTier() in
-- src/services/loyalty.ts. Redeeming spends available_points and never lowers a
-- tier, which is why this reads lifetime_points.
create or replace function public.loyalty_tier_for_points(p_lifetime_points int)
returns text
language sql
immutable
as $$
  select case
    when p_lifetime_points >= 50000 then 'diamond'
    when p_lifetime_points >= 15000 then 'platinum'
    when p_lifetime_points >= 5000  then 'gold'
    when p_lifetime_points >= 1000  then 'silver'
    else 'bronze'
  end;
$$;

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
  -- ── Reward must exist, be active, and not be expired ──────────────────────
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

  -- ── Lock the caller's loyalty row. This is what serializes concurrent
  --    redemptions for the same user; everything below runs under the lock. ──
  select lifetime_points into v_lifetime
    from public.user_loyalty
   where user_id = p_user_id
     for update;

  if not found then
    return query select 'loyalty_not_found'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  v_user_tier := public.loyalty_tier_for_points(v_lifetime);

  -- ── BUG 1 FIX: enforce tier_required server-side, in the write path ───────
  if public.loyalty_tier_rank(v_user_tier) < public.loyalty_tier_rank(v_reward.tier_required) then
    return query select 'tier_too_low'::text, null::uuid, null::int, null::int,
                        v_reward.tier_required::text, v_user_tier::text;
    return;
  end if;

  -- ── Stock, where tracked ─────────────────────────────────────────────────
  if v_reward.quantity_available is not null and v_reward.quantity_available <= 0 then
    return query select 'out_of_stock'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  -- ── BUG 2 FIX: conditional decrement. The WHERE clause is the guard; if the
  --    balance is short this updates zero rows and we reject. ───────────────
  update public.user_loyalty
     set available_points = available_points - v_reward.points_cost,
         updated_at       = now()
   where user_id = p_user_id
     and available_points >= v_reward.points_cost
  returning available_points into v_new_bal;

  if not found then
    return query select 'insufficient_points'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  -- ── Same transaction as the decrement: the grant ─────────────────────────
  insert into public.reward_redemptions (user_id, reward_id, points_spent, status)
  values (p_user_id, p_reward_id, v_reward.points_cost, 'pending')
  returning id into v_redemption;

  if v_reward.quantity_available is not null then
    update public.rewards
       set quantity_available = quantity_available - 1
     where id = p_reward_id
       and quantity_available > 0;
    if not found then
      -- lost a race for the last unit; roll the whole redemption back
      raise exception 'reward % went out of stock during redemption', p_reward_id
        using errcode = 'P0001';
    end if;
  end if;

  -- Ledger entry, so redemptions appear in transaction history. The previous
  -- application-code path never wrote one, which is why spend was invisible in
  -- GET /api/loyalty/transactions.
  insert into public.loyalty_transactions
    (user_id, points, transaction_type, description, reference_id, reference_type)
  values
    (p_user_id, -v_reward.points_cost, 'redeemed', 'Redeemed — ' || v_reward.name, v_redemption, 'reward');

  return query select 'ok'::text, v_redemption, v_reward.points_cost, v_new_bal,
                      v_reward.tier_required::text, v_user_tier::text;
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- SECURITY DEFINER + a p_user_id argument means anyone who can call this can
-- redeem as ANY user. Only the backend's service-role key may call it; the
-- backend passes req.userId from the validated JWT. Explicitly revoke the roles
-- PostgREST exposes to browsers.
revoke all on function public.redeem_reward(uuid, uuid) from public, anon, authenticated;
grant execute on function public.redeem_reward(uuid, uuid) to service_role;

revoke all on function public.loyalty_tier_rank(text) from public, anon, authenticated;
revoke all on function public.loyalty_tier_for_points(int) from public, anon, authenticated;
grant execute on function public.loyalty_tier_rank(text) to service_role;
grant execute on function public.loyalty_tier_for_points(int) to service_role;

-- Guards against a duplicate concurrent decrement ever going negative, even if
-- some future code path bypasses the function above.
alter table public.user_loyalty
  drop constraint if exists user_loyalty_available_points_non_negative;
alter table public.user_loyalty
  add constraint user_loyalty_available_points_non_negative
  check (available_points >= 0) not valid;
