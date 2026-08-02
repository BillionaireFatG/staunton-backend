-- 0007_fix_loyalty_tier_rank_cast.sql
-- ============================================================================
-- Fixes a defect in 0003_redeem_reward_atomic.sql found by
-- `npm run verify:redemption` against the live database.
--
-- SYMPTOM
--   Every redemption failed with:
--     function public.loyalty_tier_rank(loyalty_tier) does not exist
--   The tier gate raised instead of evaluating, so redemption was blocked
--   entirely — including legitimate ones.
--
-- CAUSE
--   0003 declares  loyalty_tier_rank(p_tier text)
--   but `rewards.tier_required` is the ENUM type `loyalty_tier`, and
--   `loyalty_tier_for_points()` returns text. PostgreSQL does not implicitly
--   cast an enum to text during function resolution, so the call
--     loyalty_tier_rank(v_reward.tier_required)
--   found no matching signature and raised 42883.
--
-- SEVERITY
--   Failed CLOSED, not open. The harness confirmed 0 redemptions succeeded,
--   0 points charged, balance non-negative, redemption rows == successes.
--   No double-spend was ever reachable. This restores function, it does not
--   close a new hole.
--
-- FIX
--   Add an overload accepting `loyalty_tier` directly, AND cast explicitly at
--   the call site. Either alone would do; both together mean any future call
--   site resolves regardless of which type it holds.
--
-- IDEMPOTENT: create or replace throughout; safe to re-run.
-- Depends on 0003 having been applied.
-- ============================================================================

do $$
begin
  if to_regprocedure('public.redeem_reward(uuid,uuid)') is null then
    raise exception 'PREFLIGHT FAILED: redeem_reward(uuid,uuid) not found. Apply 0003_redeem_reward_atomic.sql first.';
  end if;
  if to_regtype('public.loyalty_tier') is null then
    raise exception 'PREFLIGHT FAILED: type loyalty_tier not found. The loyalty schema (007) is not applied.';
  end if;
end $$;


-- Overload taking the enum directly, so a caller holding a `loyalty_tier`
-- resolves without an explicit cast.
create or replace function public.loyalty_tier_rank(p_tier public.loyalty_tier)
returns int
language sql
immutable
as $$
  select public.loyalty_tier_rank(p_tier::text);
$$;


-- Replace redeem_reward with the cast applied at the call site. Body is
-- otherwise byte-identical to 0003 — the row lock, the conditional decrement,
-- the same-transaction ledger writes and the status-string convention are all
-- unchanged. Only line marked FIX differs.
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

  -- Serializes concurrent redemptions for this user; everything below is under the lock.
  select lifetime_points into v_lifetime
    from public.user_loyalty
   where user_id = p_user_id
     for update;

  if not found then
    return query select 'loyalty_not_found'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  v_user_tier := public.loyalty_tier_for_points(v_lifetime);

  -- FIX: explicit ::text cast on the enum. Previously passed v_reward.tier_required
  -- (type loyalty_tier) to a function declared as (text), which raised 42883.
  if public.loyalty_tier_rank(v_user_tier) < public.loyalty_tier_rank(v_reward.tier_required::text) then
    return query select 'tier_too_low'::text, null::uuid, null::int, null::int,
                        v_reward.tier_required::text, v_user_tier::text;
    return;
  end if;

  if v_reward.quantity_available is not null and v_reward.quantity_available <= 0 then
    return query select 'out_of_stock'::text, null::uuid, null::int, null::int, null::text, null::text;
    return;
  end if;

  -- The WHERE clause is the guard: short balance => zero rows updated => reject.
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

  insert into public.reward_redemptions (user_id, reward_id, points_spent, status)
  values (p_user_id, p_reward_id, v_reward.points_cost, 'pending')
  returning id into v_redemption;

  if v_reward.quantity_available is not null then
    update public.rewards
       set quantity_available = quantity_available - 1
     where id = p_reward_id
       and quantity_available > 0;
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


-- ── Grants (re-asserted; create or replace does not preserve them) ──────────
-- SECURITY DEFINER + a p_user_id argument means anyone who can execute this can
-- redeem as ANY user. Only the backend's service-role key may call it.
revoke all on function public.redeem_reward(uuid, uuid) from public, anon, authenticated;
grant execute on function public.redeem_reward(uuid, uuid) to service_role;

revoke all on function public.loyalty_tier_rank(public.loyalty_tier) from public, anon, authenticated;
grant execute on function public.loyalty_tier_rank(public.loyalty_tier) to service_role;

-- Verify after applying:
--   npm run seed:loyalty && npm run verify:redemption
-- Expect: tier gate blocks platinum reward for a gold user with status
-- 'tier_too_low'; exactly 1 of 6 concurrent redemptions succeeds.
