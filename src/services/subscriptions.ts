// ============================================================================
// subscriptions.ts — org-scoped plans, entitlements and subscription state
// ============================================================================
// FOUNDATION ONLY. There is no payment provider: Stripe is an unmade commercial
// decision, so nothing here charges anyone. What exists is the state a provider
// would later drive.
//
// A consequence worth stating plainly, because it looks like a bug the first
// time you hit it: every seeded paid plan is INACTIVE and has NO price, so
// `setPlan()` returns 409 plan_inactive for all of them. That is correct. The
// founder sets real numbers and activates a plan; until then nothing is sellable
// and nobody can be moved onto a paid tier.
//
// ── ENTITLEMENTS ARE NOT PERMISSIONS ────────────────────────────────────────
//   roles.hasPermission(user, key)  — "what is your ROLE"    (role ∩ org status)
//   getEntitlements(org)            — "what did your firm PAY FOR"
//
// Two questions, two answers, two failure directions. A caller that needs both
// must check both; neither is a proxy for the other. Nothing in this module
// consults role_permissions, and nothing here is wired into has_permission.
//
// ── AUTHORIZATION ───────────────────────────────────────────────────────────
// The service-role client bypasses RLS and both RPCs are SECURITY DEFINER taking
// an org id, so the gates in this file are the ONLY gates. Two rules:
//
//   1. The org is ALWAYS resolved server-side from the caller's member row.
//      No route accepts an org id. This is the same rule access.ts applies to
//      has_permission, and for the same reason: passing another org's id there
//      previously returned an answer computed against a stranger's status.
//   2. Reading your own firm's subscription needs membership. CHANGING it needs
//      org admin or platform admin — it is a commercial commitment, not a
//      preference.
// ============================================================================

import { supabase } from '../lib/supabase'
import { hasPermission } from './roles'
import {
  Entitlements,
  EntitlementValue,
  OrgSubscription,
  SubscriptionPlan,
} from '../types'

const err = (message: string, statusCode: number, code?: string) =>
  Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) })

/** Statuses under which a plan's entitlements actually apply. Mirrors the SQL. */
const GRANTING_STATUSES = ['trialing', 'active'] as const

// ── Caller → org ────────────────────────────────────────────────────────────

interface CallerOrg {
  orgId: string
  memberId: string
  isOrgAdmin: boolean
}

/**
 * The caller's org, from their member row.
 *
 * Never from the request. A route that accepted `org_id` would let any member of
 * any firm read — or worse, change — another firm's subscription, and the RPCs
 * below would happily compute the answer because they take the org id on trust.
 */
async function callerOrg(userId: string): Promise<CallerOrg> {
  const { data, error } = await supabase
    .from('members')
    .select('id, org_id, is_admin')
    .eq('auth_user_id', userId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) throw err('You are not a member of any organization', 403, 'not_a_member')

  return { orgId: data.org_id, memberId: data.id, isOrgAdmin: data.is_admin === true }
}

// ── Plan catalogue ──────────────────────────────────────────────────────────

const PLAN_COLUMNS =
  'id, key, name, description, price_amount, price_currency, price_interval, is_placeholder_pricing, is_active, is_base, sort_order'

/**
 * The shape PLAN_COLUMNS selects.
 *
 * Declared explicitly because supabase-js infers row types by parsing the select
 * string at the type level, and it cannot follow one held in a const — it falls
 * back to an error type and every field access fails to compile. The cast is
 * narrow and sits directly beside the string it describes; keep them in step.
 */
interface PlanRow {
  id: string
  key: string
  name: string
  description: string | null
  price_amount: number | string | null
  price_currency: string
  price_interval: string
  is_placeholder_pricing: boolean
  is_active: boolean
  is_base: boolean
  sort_order: number
}

/**
 * The plan catalogue.
 *
 * `price` is returned EXACTLY as stored, which today means `null` for every
 * plan. It is never coerced to 0 and never given a placeholder number: a price
 * shown to a trading desk is the one figure that must not be invented, and the
 * design charter's honest-UI rule forbids fabricated stats generally.
 * `pricing_status` is what clients should branch on, so no one has to infer
 * meaning from a null.
 *
 * Unreleased packaging is not public. Inactive plans are visible only to someone
 * who can actually act on them (an org admin choosing a plan, or a platform
 * admin); ordinary members see the sellable catalogue only.
 */
export async function listPlans(userId: string): Promise<SubscriptionPlan[]> {
  const [{ isOrgAdmin }, isPlatformAdmin] = await Promise.all([
    callerOrg(userId),
    hasPermission(userId, 'admin.assign_role'),
  ])
  const maySeeUnreleased = isOrgAdmin || isPlatformAdmin

  let query = supabase
    .from('subscription_plans')
    .select(PLAN_COLUMNS)
    .order('sort_order', { ascending: true })

  if (!maySeeUnreleased) query = query.or('is_active.eq.true,is_base.eq.true')

  const { data, error } = await query
  if (error) throw new Error(error.message)

  return ((data ?? []) as unknown as PlanRow[]).map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description ?? null,
    // Null until the founder sets a real number. Not 0, not a guess.
    price: p.price_amount === null ? null : Number(p.price_amount),
    currency: p.price_currency,
    interval: p.price_interval,
    pricing_status: p.price_amount === null || p.is_placeholder_pricing ? 'not_set' : 'set',
    is_active: p.is_active,
    is_base: p.is_base,
    sort_order: p.sort_order,
  }))
}

// ── Entitlements ────────────────────────────────────────────────────────────

/**
 * Effective entitlements for the caller's org, in ONE database call.
 *
 * FAILS CLOSED. resolve_org_entitlements() returns base-plan entitlements when
 * the org has no subscription or a non-granting one, and returns NOTHING at all
 * if the base plan is missing. So an empty map means "entitled to nothing", and
 * every consumer below treats an absent key as denied. There is no path that
 * yields full access by default.
 */
export async function getEntitlements(userId: string): Promise<Entitlements> {
  const { orgId } = await callerOrg(userId)
  return resolveForOrg(orgId)
}

async function resolveForOrg(orgId: string): Promise<Entitlements> {
  const { data, error } = await supabase.rpc('resolve_org_entitlements', { p_org: orgId })

  if (error) {
    if ((error as { code?: string }).code === 'PGRST202') {
      throw err(
        'Entitlements are unavailable: database migration 0011_subscriptions_foundation.sql ' +
          'has not been applied. Apply it in the Supabase SQL editor.',
        503,
      )
    }
    throw new Error(error.message)
  }

  const out: Entitlements = {}
  for (const row of (data ?? []) as { key: string; value: EntitlementValue; source: string }[]) {
    out[row.key] = { ...row.value, source: row.source as 'base' | 'plan' }
  }
  return out
}

/**
 * The gate other services should call.
 *
 * Deliberately NOT merged into roles.hasPermission(): a caller that needs both a
 * role and a paid feature must ask both questions, and seeing both calls at the
 * call site is the point.
 *
 * Every ambiguity resolves to DENIED — missing key, wrong shape, unknown type.
 * The one exception is an explicit `{"type":"limit","value":null}`, which means
 * unlimited and is why "unlimited" is spelled as a present row with a null value
 * rather than as an absent key.
 */
export async function isEntitled(userId: string, key: string): Promise<boolean> {
  const ent = await getEntitlements(userId)
  const e = ent[key]
  if (!e) return false // absent = not entitled

  if (e.type === 'boolean') return e.value === true
  if (e.type === 'limit') return e.value === null || (typeof e.value === 'number' && e.value > 0)
  if (e.type === 'string') return typeof e.value === 'string' && e.value.length > 0
  return false
}

/**
 * Remaining headroom under a numeric entitlement.
 *
 * Returns null for "unlimited". Throws 403 when the limit is reached, so callers
 * get a consistent refusal rather than each inventing one.
 */
export async function assertWithinLimit(
  userId: string,
  key: string,
  currentUsage: number,
): Promise<number | null> {
  const ent = await getEntitlements(userId)
  const e = ent[key]

  if (!e || e.type !== 'limit') {
    throw err(`Your plan does not include ${key}`, 403, 'not_entitled')
  }
  if (e.value === null) return null // unlimited
  if (typeof e.value !== 'number') {
    // A malformed row must not read as permission.
    throw err(`Your plan does not include ${key}`, 403, 'not_entitled')
  }
  if (currentUsage >= e.value) {
    throw err(
      `Your plan allows ${e.value} for ${key} and your organization is at ${currentUsage}.`,
      403,
      'limit_reached',
    )
  }
  return e.value - currentUsage
}

// ── Current subscription ────────────────────────────────────────────────────

export async function getMySubscription(userId: string): Promise<OrgSubscription> {
  const { orgId } = await callerOrg(userId)

  const { data, error } = await supabase
    .from('org_subscriptions')
    .select('org_id, plan_id, status, started_at, current_period_end, canceled_at, version, updated_at')
    .eq('org_id', orgId)
    .maybeSingle()

  if (error) throw new Error(error.message)

  const entitlements = await resolveForOrg(orgId)

  // No row is a legitimate, common state — it is what every firm looks like
  // before anything is sold. Reported as the base plan rather than as a 404, so
  // clients have one shape to render.
  if (!data) {
    return {
      org_id: orgId,
      plan_key: 'base',
      plan_name: 'Base',
      status: 'none',
      is_granting: false,
      started_at: null,
      current_period_end: null,
      canceled_at: null,
      entitlements,
    }
  }

  const { data: plan } = await supabase
    .from('subscription_plans')
    .select('key, name')
    .eq('id', data.plan_id)
    .maybeSingle()

  return {
    org_id: orgId,
    plan_key: plan?.key ?? 'unknown',
    plan_name: plan?.name ?? 'Unknown',
    status: data.status,
    is_granting: (GRANTING_STATUSES as readonly string[]).includes(data.status),
    started_at: data.started_at ?? null,
    current_period_end: data.current_period_end ?? null,
    canceled_at: data.canceled_at ?? null,
    entitlements,
  }
}

export async function getSubscriptionHistory(userId: string, limit = 50) {
  const { orgId } = await callerOrg(userId)
  await assertMayChange(userId, orgId) // commercial history is admin-only

  const { data, error } = await supabase
    .from('subscription_events')
    .select('id, event_type, from_status, to_status, reason, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 100))

  if (error) throw new Error(error.message)
  return data ?? []
}

// ── State changes ───────────────────────────────────────────────────────────

/**
 * Changing what a firm pays for is a commercial commitment, so it needs an
 * admin — an ordinary member of the firm must not be able to do it.
 */
async function assertMayChange(userId: string, orgId: string): Promise<void> {
  const [{ isOrgAdmin, orgId: callerOrgId }, isPlatformAdmin] = await Promise.all([
    callerOrg(userId),
    hasPermission(userId, 'admin.assign_role'),
  ])

  if (isPlatformAdmin) return
  if (isOrgAdmin && callerOrgId === orgId) return

  throw err('Only an organization admin may change the subscription', 403, 'not_authorized')
}

/** set_org_subscription() outcome → HTTP. */
const OUTCOME: Record<string, { status: number; code: string; message: string }> = {
  org_not_found: { status: 404, code: 'org_not_found', message: 'Organization not found' },
  plan_not_found: { status: 404, code: 'plan_not_found', message: 'No such plan' },
  invalid_status: { status: 400, code: 'invalid_status', message: 'Invalid subscription status' },
  plan_inactive: {
    status: 409,
    code: 'plan_inactive',
    message:
      'That plan is not available for subscription yet: its pricing has not been set. ' +
      'This is expected — no paid plan is sellable until real pricing is configured.',
  },
  concurrent_modification: {
    status: 409,
    code: 'concurrent_modification',
    message: 'The subscription was changed by someone else at the same time. Re-read it and retry.',
  },
}

/**
 * Move the caller's org onto a plan.
 *
 * All the real work is in set_org_subscription(): row lock, re-validation under
 * the lock, version-conditional update and the audit row, in one transaction.
 * That is the 0003 pattern, used here because subscription state is the same
 * read-then-write shape that produced this codebase's double-spend — two
 * concurrent changes would otherwise resolve to whichever committed last, with
 * an audit log implying both applied in order.
 */
export async function setPlan(
  userId: string,
  planKey: string,
  status: string = 'active',
  reason?: string,
): Promise<OrgSubscription> {
  const { orgId } = await callerOrg(userId)
  await assertMayChange(userId, orgId)

  const { data, error } = await supabase.rpc('set_org_subscription', {
    p_org: orgId,
    p_plan_key: planKey,
    p_status: status,
    p_actor: userId, // recorded for audit; the RPC does not treat it as authority
    p_reason: reason ?? null,
  })

  if (error) {
    if ((error as { code?: string }).code === 'PGRST202') {
      throw err(
        'Subscriptions are unavailable: database migration 0011_subscriptions_foundation.sql ' +
          'has not been applied. Apply it in the Supabase SQL editor.',
        503,
      )
    }
    throw new Error(error.message)
  }

  const row = (Array.isArray(data) ? data[0] : data) as { status_out?: string } | undefined
  const outcome = row?.status_out

  if (!outcome) throw new Error('set_org_subscription returned no status')
  if (outcome !== 'ok' && outcome !== 'unchanged') {
    const mapped = OUTCOME[outcome]
    if (mapped) throw err(mapped.message, mapped.status, mapped.code)
    throw new Error(`set_org_subscription returned an unrecognized status: ${outcome}`)
  }

  return getMySubscription(userId)
}

/**
 * Cancel.
 *
 * Moves the org to the BASE plan with status 'canceled', rather than deleting
 * the row or leaving a paid plan attached with a dead status. The org keeps
 * exactly the base entitlements — which is what resolve_org_entitlements() would
 * return anyway, so the stored state and the resolved answer agree instead of
 * relying on the resolver to ignore a stale plan_id.
 */
export async function cancel(userId: string, reason?: string): Promise<OrgSubscription> {
  return setPlan(userId, 'base', 'canceled', reason)
}
