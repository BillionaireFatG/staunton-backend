-- 0011_subscriptions_foundation.sql
-- ============================================================================
-- SUBSCRIPTION FOUNDATION — schema, entitlements, atomic state changes.
--
-- Context: commission is ~$1/tonne (~10bp), which is inside the band existing
-- intermediaries already charge. Subscriptions COMPLEMENT that rather than
-- replace it — komgo, the healthiest survivor of the 2019 consortium cohort,
-- deliberately chose subscription over per-transaction pricing.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
-- There is NO payment provider here. Stripe is an unmade commercial decision,
-- and wiring one in would be inventing the answer. There are no card tokens, no
-- webhooks, no invoices. What exists is the state a payment provider would later
-- drive, so adding one is an integration rather than a redesign.
--
-- Consequently EVERY SEEDED PAID PLAN IS INACTIVE AND CARRIES NO PRICE. That is
-- not an oversight and it is not a placeholder to be filled in by an engineer:
--
--   * price_amount is NULL, not a number. A seeded "$499" leaks into a UI and
--     becomes a price the founder never agreed to. The honest-UI rule in the
--     design charter says no fabricated figures, and a price is the single worst
--     figure to fabricate. NULL cannot be rendered as a real number by accident.
--   * is_active = false, so set_org_subscription() REFUSES them with
--     'plan_inactive'. Nobody can subscribe to a plan whose price does not exist
--     yet. This is the intended behaviour of a fresh install, not a bug — the
--     founder sets real numbers and flips is_active, in that order.
--
-- ── ENTITLEMENTS ARE NOT PERMISSIONS ────────────────────────────────────────
-- Kept deliberately separate from has_permission():
--
--   has_permission(user, key)  = "what is your ROLE" — role grants ∩ org status.
--   entitlements(org)          = "what did your firm PAY FOR".
--
-- Collapsing them is tempting and wrong. A firm's admin has admin rights whether
-- or not the invoice is paid; conversely paying for an enterprise plan must not
-- confer the ability to assign roles. They answer different questions and they
-- fail in different directions, so a caller has to satisfy BOTH where both
-- apply. Nothing in this migration touches roles, role_permissions or
-- has_permission.
--
-- ── ENTITLEMENTS ARE KEY/VALUE, NOT A TIER ENUM ─────────────────────────────
-- A hardcoded tier enum ('free' | 'pro' | 'enterprise') puts the product
-- catalogue in a CHECK constraint, so every packaging change is a migration and
-- a deploy — and packaging will change repeatedly before this platform has its
-- first renewal. plan_entitlements is (plan_id, key) -> jsonb value, so a new
-- limit is a row.
--
-- ── FAIL CLOSED ─────────────────────────────────────────────────────────────
-- No subscription resolves to the BASE plan's entitlements — never to full
-- access, and never to "unlimited". If the base plan itself is missing,
-- resolve_org_entitlements() returns ZERO rows, which every caller must read as
-- "entitled to nothing". A resolver that opens up when its own configuration is
-- absent is the standard way this class of bug ships.
--
-- ── ATOMICITY ───────────────────────────────────────────────────────────────
-- This codebase has a documented double-spend (six concurrent redemptions
-- granted 18,000pts while charging 3,000) caused by a non-atomic read-then-write
-- in application code. Subscription state has the same shape, so it uses the
-- same remedy as 0003: take a row lock, re-validate every gate UNDER that lock,
-- then update CONDITIONALLY on a version that has not moved. Concurrent callers
-- serialize; the loser is rejected rather than silently overwriting.
--
-- IDEMPOTENT: guarded on object existence, safe to re-run.
-- ============================================================================


-- ── Preflight ───────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.organizations') is null then
    raise exception 'public.organizations is missing — subscriptions are org-scoped and cannot be created without it';
  end if;
  raise notice 'preflight OK: organizations present';
end $$;


-- ============================================================================
-- PART A — PLAN CATALOGUE
-- ============================================================================
create table if not exists public.subscription_plans (
  id                      uuid primary key default gen_random_uuid(),
  key                     text not null unique,
  name                    text not null,
  description             text,

  -- NULL until the founder sets a real number. See the header: a seeded price is
  -- a fabricated figure, and this one would be quoted back to a trading desk.
  price_amount            numeric(12,2),
  price_currency          text not null default 'USD',
  price_interval          text not null default 'month'
                            check (price_interval in ('month','year')),

  -- Explicit, so no client has to infer "unpriced" from a NULL and guess.
  is_placeholder_pricing  boolean not null default true,

  -- Sellable. False on every seeded plan; set_org_subscription() refuses it.
  is_active               boolean not null default false,

  -- The floor everyone gets with no subscription. Exactly one row, enforced
  -- below. Not sellable and not cancellable-away-from.
  is_base                 boolean not null default false,

  sort_order              int not null default 100,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Exactly one base plan. A second one would make "the floor" ambiguous and the
-- resolver would silently pick whichever the planner returned first.
create unique index if not exists uq_subscription_plans_single_base
  on public.subscription_plans ((true)) where is_base;

-- A priced plan must not still be flagged placeholder, and an active plan must
-- have a price. Together these make "active, sellable, and free by accident"
-- unrepresentable. NOT VALID so the constraint cannot fail on legacy rows;
-- it is enforced for everything written from here on.
do $$
begin
  alter table public.subscription_plans
    drop constraint if exists subscription_plans_active_requires_real_price;
  alter table public.subscription_plans
    add constraint subscription_plans_active_requires_real_price
    check (
      is_base
      or not is_active
      or (price_amount is not null and is_placeholder_pricing = false)
    ) not valid;
exception when others then
  raise warning 'could not add subscription_plans_active_requires_real_price: %', sqlerrm;
end $$;


-- ============================================================================
-- PART B — ENTITLEMENTS (key/value, not a tier enum)
-- ============================================================================
-- `value` is jsonb so one table carries booleans, numeric limits and strings
-- without a column per shape. Convention, enforced by the resolver's consumers
-- rather than by the database:
--
--   {"type":"boolean","value":true}
--   {"type":"limit","value":5}          -- a number; null means unlimited
--   {"type":"string","value":"email"}
--
-- "unlimited" is deliberately spelled `{"type":"limit","value":null}` rather
-- than -1 or a missing row. A MISSING row means NOT ENTITLED — the two must not
-- be confusable, because the failure directions are opposite.
create table if not exists public.plan_entitlements (
  plan_id     uuid not null references public.subscription_plans(id) on delete cascade,
  key         text not null,
  value       jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (plan_id, key)
);

create index if not exists idx_plan_entitlements_key
  on public.plan_entitlements (key);


-- ============================================================================
-- PART C — CURRENT SUBSCRIPTION STATE, ONE ROW PER ORG
-- ============================================================================
-- org_id is the PRIMARY KEY, not merely indexed. An org has exactly one current
-- subscription; two concurrent subscribe calls therefore cannot produce two
-- live rows regardless of what the application layer does. History lives in
-- subscription_events (Part D) rather than in duplicate state rows.
create table if not exists public.org_subscriptions (
  org_id              uuid primary key references public.organizations(id) on delete cascade,
  plan_id             uuid not null references public.subscription_plans(id),

  status              text not null
                        check (status in ('trialing','active','past_due','canceled','expired')),

  started_at          timestamptz not null default now(),
  current_period_end  timestamptz,
  canceled_at         timestamptz,

  -- Optimistic-concurrency guard. Every state change updates WHERE version = the
  -- value read under the lock, so a racing writer updates zero rows and is told
  -- so, instead of last-write-wins.
  version             int not null default 0,

  -- Where a payment provider's identifier would go. Present so adding one is an
  -- integration and not a migration of live rows; NULL and unused today.
  external_ref        text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_org_subscriptions_status
  on public.org_subscriptions (status);


-- ============================================================================
-- PART D — APPEND-ONLY AUDIT
-- ============================================================================
-- Subscription state is a commercial record: who moved this firm onto which plan
-- and when. The state table is mutable by design, so the history has to live
-- somewhere that is not.
create table if not exists public.subscription_events (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  event_type      text not null,
  from_plan_id    uuid references public.subscription_plans(id),
  to_plan_id      uuid references public.subscription_plans(id),
  from_status     text,
  to_status       text,
  -- The auth user who caused it. Nullable for changes made by an automated
  -- process (expiry sweeps, and later a payment webhook).
  actor_user_id   uuid,
  reason          text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_subscription_events_org_created
  on public.subscription_events (org_id, created_at desc);


-- ============================================================================
-- PART E — SEED: ONE BASE PLAN, TWO UNPRICED INACTIVE PAID PLANS
-- ============================================================================
-- Names and entitlement VALUES are provisional and commercial, exactly like the
-- stage weights in the master document. They define what a plan means to a
-- customer, which is the founder's call, not an engineering one.
--
-- Seeded with ON CONFLICT DO NOTHING so re-running never overwrites numbers the
-- founder has since set. That matters: this file is applied by hand and may well
-- be re-run after real pricing exists.
insert into public.subscription_plans
  (key, name, description, price_amount, is_placeholder_pricing, is_active, is_base, sort_order)
values
  ('base',
   'Base',
   'Included with membership. The floor every member firm has, with or without a paid plan.',
   null, false, true, true, 0),

  ('desk',
   'Desk',
   'PLACEHOLDER — pricing not set. Intended for a single trading desk.',
   null, true, false, false, 10),

  ('enterprise',
   'Enterprise',
   'PLACEHOLDER — pricing not set. Intended for multi-desk firms.',
   null, true, false, false, 20)
on conflict (key) do nothing;

-- Entitlements. The base row set is the FAIL-CLOSED FLOOR, so it is deliberately
-- conservative: enough to use the platform, nothing that costs real money to
-- deliver. Paid plans overlay it key-by-key.
--
-- Note every paid entitlement is still unreachable today, because both paid
-- plans are inactive. Seeding them now means the resolver is exercised against
-- realistic data rather than an empty table.
do $$
declare
  v_base uuid;
  v_desk uuid;
  v_ent  uuid;
begin
  select id into v_base from public.subscription_plans where key = 'base';
  select id into v_desk from public.subscription_plans where key = 'desk';
  select id into v_ent  from public.subscription_plans where key = 'enterprise';

  if v_base is not null then
    insert into public.plan_entitlements (plan_id, key, value) values
      (v_base, 'deals.active_max',        '{"type":"limit","value":3}'),
      (v_base, 'members.seats_max',       '{"type":"limit","value":3}'),
      (v_base, 'messaging.direct',        '{"type":"boolean","value":true}'),
      (v_base, 'messaging.global',        '{"type":"boolean","value":true}'),
      (v_base, 'voice.rooms',             '{"type":"boolean","value":false}'),
      (v_base, 'report.export',           '{"type":"boolean","value":false}'),
      (v_base, 'report.share_tokens_max', '{"type":"limit","value":0}'),
      (v_base, 'api.access',              '{"type":"boolean","value":false}'),
      (v_base, 'support.tier',            '{"type":"string","value":"community"}')
    on conflict (plan_id, key) do nothing;
  end if;

  if v_desk is not null then
    insert into public.plan_entitlements (plan_id, key, value) values
      (v_desk, 'deals.active_max',        '{"type":"limit","value":25}'),
      (v_desk, 'members.seats_max',       '{"type":"limit","value":10}'),
      (v_desk, 'voice.rooms',             '{"type":"boolean","value":true}'),
      (v_desk, 'report.export',           '{"type":"boolean","value":true}'),
      (v_desk, 'report.share_tokens_max', '{"type":"limit","value":25}'),
      (v_desk, 'support.tier',            '{"type":"string","value":"email"}')
    on conflict (plan_id, key) do nothing;
  end if;

  if v_ent is not null then
    -- `null` here is UNLIMITED, and it is spelled as an explicit limit row with a
    -- null value rather than by omitting the key. An omitted key means NOT
    -- entitled; the two must never collapse into each other.
    insert into public.plan_entitlements (plan_id, key, value) values
      (v_ent, 'deals.active_max',        '{"type":"limit","value":null}'),
      (v_ent, 'members.seats_max',       '{"type":"limit","value":null}'),
      (v_ent, 'voice.rooms',             '{"type":"boolean","value":true}'),
      (v_ent, 'report.export',           '{"type":"boolean","value":true}'),
      (v_ent, 'report.share_tokens_max', '{"type":"limit","value":null}'),
      (v_ent, 'api.access',              '{"type":"boolean","value":true}'),
      (v_ent, 'support.tier',            '{"type":"string","value":"dedicated"}')
    on conflict (plan_id, key) do nothing;
  end if;

  raise notice 'seeded base + 2 INACTIVE, UNPRICED paid plans and their entitlements';
end $$;


-- ============================================================================
-- PART F — resolve_org_entitlements(): the whole answer, in ONE call
-- ============================================================================
-- Returns the effective entitlement set for an org: base overlaid with the
-- org's plan, where the org holds a subscription in a GRANTING status.
--
-- Granting statuses are 'trialing' and 'active' ONLY. 'past_due' deliberately
-- does NOT grant: an unpaid firm falls back to base rather than keeping paid
-- features. That is a commercial choice the founder may want to soften with a
-- grace period later — it is one predicate, and it is written down here rather
-- than buried in application code.
--
-- FAIL CLOSED, in three separate ways, because this is the function that decides
-- what a paying customer gets:
--   * no subscription row            -> base only
--   * status not granting            -> base only
--   * base plan missing entirely     -> ZERO rows (entitled to nothing)
-- There is no branch that returns "everything".
--
-- ⚠️ SECURITY DEFINER taking an org id. Same shape as finding F-16, so the same
-- grants: service_role ONLY. The backend resolves the caller's org server-side
-- from their member row and never accepts an org id from the client — the same
-- rule access.ts already applies to has_permission. search_path is pinned, which
-- F-16's functions omitted.
create or replace function public.resolve_org_entitlements(p_org uuid)
returns table (
  key    text,
  value  jsonb,
  source text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with base_plan as (
    select id from public.subscription_plans where is_base limit 1
  ),
  -- The org's plan, but only when the subscription actually grants.
  granting_plan as (
    select s.plan_id
      from public.org_subscriptions s
     where s.org_id = p_org
       and s.status in ('trialing','active')
     limit 1
  ),
  base_ent as (
    select e.key, e.value
      from public.plan_entitlements e
      join base_plan b on b.id = e.plan_id
  ),
  plan_ent as (
    select e.key, e.value
      from public.plan_entitlements e
      join granting_plan g on g.plan_id = e.plan_id
  )
  -- Full outer join so a paid plan may add keys the base does not carry, while
  -- keys only the base carries survive. coalesce picks the paid value where both
  -- exist: the plan overlays the floor, it never lowers it implicitly.
  select coalesce(p.key, b.key)                             as key,
         coalesce(p.value, b.value)                         as value,
         case when p.key is not null then 'plan' else 'base' end as source
    from base_ent b
    full outer join plan_ent p on p.key = b.key
   order by 1;
$$;

revoke all on function public.resolve_org_entitlements(uuid) from public, anon, authenticated;
grant execute on function public.resolve_org_entitlements(uuid) to service_role;

comment on function public.resolve_org_entitlements(uuid) is
  'Effective entitlements for one org: base plan overlaid with the org''s plan when its subscription status grants (trialing/active). Fails closed — no subscription, a non-granting status, or a missing base plan all yield base-or-nothing, never full access. SECURITY DEFINER, service_role only.';


-- ============================================================================
-- PART G — set_org_subscription(): the ONLY supported state change
-- ============================================================================
-- Atomic, following 0003 exactly: lock the row, re-validate every gate under the
-- lock, update CONDITIONALLY on the version read under it, and write the audit
-- row in the same transaction (a plpgsql body is atomic).
--
-- Why the version guard is not paranoia. Without it, two concurrent calls —
-- "upgrade to enterprise" and "cancel" — both read the same state and both
-- write; the outcome depends on which commits last, and the audit log records
-- both as if they applied in sequence. That is exactly the read-then-write shape
-- that produced this codebase's double-spend.
--
-- Returns a status string rather than raising, so the API maps outcomes to HTTP
-- codes without depending on SQLSTATE surviving PostgREST — same convention as
-- redeem_reward().
--
-- AUTHORIZATION IS NOT DONE HERE. It is done in services/subscriptions.ts, which
-- is the layer that knows the caller. p_actor is recorded for audit, and is NOT
-- treated as proof of anything.
create or replace function public.set_org_subscription(
  p_org       uuid,
  p_plan_key  text,
  p_status    text,
  p_actor     uuid default null,
  p_reason    text default null
)
returns table (
  status_out    text,
  org_id_out    uuid,
  plan_key_out  text,
  sub_status    text,
  version_out   int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan     record;
  v_existing record;
  v_version  int;
  v_from_plan uuid;
  v_from_status text;
  v_new_version int;
begin
  if p_status is null or p_status not in ('trialing','active','past_due','canceled','expired') then
    return query select 'invalid_status'::text, p_org, null::text, null::text, null::int;
    return;
  end if;

  if not exists (select 1 from public.organizations where id = p_org) then
    return query select 'org_not_found'::text, p_org, null::text, null::text, null::int;
    return;
  end if;

  select id, key, is_active, is_base, price_amount, is_placeholder_pricing
    into v_plan
    from public.subscription_plans
   where key = p_plan_key;

  if not found then
    return query select 'plan_not_found'::text, p_org, p_plan_key, null::text, null::int;
    return;
  end if;

  -- A plan may only be SOLD once it is active, and the CHECK constraint in Part A
  -- means active implies a real, non-placeholder price. So this single gate is
  -- what stops anyone subscribing a firm to a plan whose price does not exist.
  -- Every seeded paid plan fails here today, by design.
  --
  -- Moving an org TO base is exempt: that is the fail-closed floor, i.e. the
  -- effect of cancelling, and it must always be reachable.
  if not v_plan.is_base and not v_plan.is_active then
    return query select 'plan_inactive'::text, p_org, v_plan.key, null::text, null::int;
    return;
  end if;

  -- ── Lock the org's subscription row. Everything below runs under it. ──────
  select plan_id, status, version
    into v_existing
    from public.org_subscriptions
   where org_id = p_org
     for update;

  if not found then
    -- First subscription for this org. org_id is the primary key, so a
    -- concurrent insert loses on the unique violation rather than creating a
    -- second live row; caught and reported rather than surfaced as a 500.
    begin
      insert into public.org_subscriptions (org_id, plan_id, status, version)
      values (p_org, v_plan.id, p_status, 1)
      returning version into v_new_version;
    exception when unique_violation then
      return query select 'concurrent_modification'::text, p_org, v_plan.key, null::text, null::int;
      return;
    end;

    v_from_plan := null;
    v_from_status := null;
  else
    v_version     := v_existing.version;
    v_from_plan   := v_existing.plan_id;
    v_from_status := v_existing.status;

    -- No-op changes are reported as such rather than writing a misleading audit
    -- row saying something happened.
    if v_existing.plan_id = v_plan.id and v_existing.status = p_status then
      return query select 'unchanged'::text, p_org, v_plan.key, p_status, v_version;
      return;
    end if;

    -- CONDITIONAL UPDATE. `version = v_version` is the guard: a racing writer
    -- that already moved this row updates zero rows here and is rejected.
    update public.org_subscriptions
       set plan_id            = v_plan.id,
           status             = p_status,
           canceled_at        = case when p_status in ('canceled','expired') then now() else null end,
           version            = version + 1,
           updated_at         = now()
     where org_id  = p_org
       and version = v_version
    returning version into v_new_version;

    if not found then
      return query select 'concurrent_modification'::text, p_org, v_plan.key, null::text, v_version;
      return;
    end if;
  end if;

  -- Same transaction as the state change.
  insert into public.subscription_events
    (org_id, event_type, from_plan_id, to_plan_id, from_status, to_status, actor_user_id, reason)
  values
    (p_org,
     case
       when v_from_plan is null then 'created'
       when p_status in ('canceled','expired') then 'canceled'
       when v_from_plan <> v_plan.id then 'plan_changed'
       else 'status_changed'
     end,
     v_from_plan, v_plan.id, v_from_status, p_status, p_actor, p_reason);

  return query select 'ok'::text, p_org, v_plan.key, p_status, v_new_version;
end;
$$;

revoke all on function public.set_org_subscription(uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_org_subscription(uuid, text, text, uuid, text)
  to service_role;

comment on function public.set_org_subscription(uuid, text, text, uuid, text) is
  'The only supported subscription state change. Atomic: row lock + re-validation under the lock + version-conditional update + audit row, all in one transaction. Refuses inactive plans, so an unpriced seeded plan cannot be sold. Authorization is the caller''s job — p_actor is recorded for audit only. SECURITY DEFINER, service_role only.';


-- ============================================================================
-- PART H — THESE TABLES ARE BACKEND-ONLY
-- ============================================================================
-- Same posture as voice_room_messages in 0009: RLS on with NO policies, which
-- denies every role that does not bypass RLS. The service-role key bypasses it,
-- so services/subscriptions.ts keeps working and its authorization checks become
-- the only way in — the three-layer rule rather than an exception to it.
--
-- This matters more here than elsewhere. A client-writable org_subscriptions row
-- is a self-service upgrade to any plan: the firm sets status='active' and takes
-- the entitlements without paying. The revoke is the control; RLS is the second
-- line.
--
-- Note the plan CATALOGUE is locked down too. It is tempting to leave
-- subscription_plans readable so a pricing page can query it directly, but that
-- is exactly the direct-Supabase read the architecture rule forbids, and it
-- would expose unreleased packaging and unpriced plans to anyone with the
-- browser key. GET /api/subscriptions/plans serves it, filtered.
do $$
declare t text;
begin
  foreach t in array array[
    'subscription_plans',
    'plan_entitlements',
    'org_subscriptions',
    'subscription_events'
  ] loop
    if to_regclass('public.' || t) is null then
      raise warning 'public.% missing — skipped lockdown', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);
    -- Table-level revoke, not column-level: against Supabase's stock
    -- GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated a bare
    -- column REVOKE is a silent no-op. That is the defect that made 0005 inert;
    -- see 0010 and tests/migration-column-privileges.test.ts.
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);

    raise notice '%: RLS on, no policies, anon/authenticated revoked, backend-only', t;
  end loop;
end $$;


-- ============================================================================
-- VERIFICATION — run these after applying. Expected results are stated.
-- Or just run `npm run verify:subscriptions`, which asserts all of it.
-- ============================================================================
--
-- 1. Exactly one base plan. Expect 1.
--
--    select count(*) from public.subscription_plans where is_base;
--
-- 2. NO seeded paid plan is sellable, and none carries an invented price.
--    Expect ZERO rows.
--
--    select key, price_amount, is_active from public.subscription_plans
--     where not is_base and (is_active or price_amount is not null);
--
-- 3. The active-requires-real-price constraint actually bites. Expect ERROR
--    (23514 check_violation), NOT success:
--
--    update public.subscription_plans set is_active = true where key = 'desk';
--
-- 4. Selling an inactive plan is refused. Expect status_out = 'plan_inactive'.
--
--    select status_out from public.set_org_subscription(
--      (select id from public.organizations limit 1), 'desk', 'active');
--
-- 5. Fail-closed resolution. For an org with NO subscription, expect ONLY rows
--    with source='base' — and specifically report.export = false:
--
--    select key, value, source from public.resolve_org_entitlements(
--      (select id from public.organizations limit 1));
--
-- 6. Nothing client-reachable. Expect ZERO rows.
--
--    select table_name, grantee, privilege_type from information_schema.table_privileges
--     where table_schema='public' and grantee in ('anon','authenticated')
--       and table_name in ('subscription_plans','plan_entitlements',
--                          'org_subscriptions','subscription_events');
--
-- 7. Both functions are service_role-only. Expect exactly one grantee each.
--
--    select routine_name, grantee from information_schema.routine_privileges
--     where routine_schema='public'
--       and routine_name in ('resolve_org_entitlements','set_org_subscription');
--
-- 8. The live proof, with the browser publishable key — expect 42501 / PGRST202,
--    never a result:
--
--      curl -s "$SUPABASE_URL/rest/v1/org_subscriptions?select=*" \
--           -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
-- ============================================================================
