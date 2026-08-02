import { supabase } from '../lib/supabase'
import { LoyaltyTier, LoyaltyState, LoyaltyTransaction, Reward, Achievement } from '../types'

const TIER_THRESHOLDS: Record<LoyaltyTier, number> = {
  bronze: 0,
  silver: 1000,
  gold: 5000,
  platinum: 15000,
  diamond: 50000,
}

export function getTier(points: number): LoyaltyTier {
  if (points >= TIER_THRESHOLDS.diamond) return 'diamond'
  if (points >= TIER_THRESHOLDS.platinum) return 'platinum'
  if (points >= TIER_THRESHOLDS.gold) return 'gold'
  if (points >= TIER_THRESHOLDS.silver) return 'silver'
  return 'bronze'
}

export function getTierProgress(points: number): { current: LoyaltyTier; next: LoyaltyTier | null; progress: number } {
  const current = getTier(points)
  const tiers = Object.keys(TIER_THRESHOLDS) as LoyaltyTier[]
  const currentIndex = tiers.indexOf(current)
  const next = tiers[currentIndex + 1] ?? null

  if (!next) return { current, next: null, progress: 100 }

  const currentThreshold = TIER_THRESHOLDS[current]
  const nextThreshold = TIER_THRESHOLDS[next]
  const progress = Math.round(((points - currentThreshold) / (nextThreshold - currentThreshold)) * 100)

  return { current, next, progress }
}

export async function getUserLoyalty(
  userId: string,
): Promise<
  LoyaltyState & {
    tier: LoyaltyTier
    progress: ReturnType<typeof getTierProgress>
    points_redeemed: number
  }
> {
  const { data, error } = await supabase
    .from('user_loyalty')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error || !data) throw Object.assign(new Error('Loyalty record not found'), { statusCode: 404 })

  // Tier is derived from cumulative points earned over the account's lifetime,
  // so redeeming (which only reduces available_points) never lowers a tier.
  const tier = getTier(data.lifetime_points)
  const progress = getTierProgress(data.lifetime_points)
  const points_redeemed = await getPointsRedeemed(userId)
  return { ...data, tier, progress, points_redeemed }
}

export async function getLoyaltyTransactions(userId: string): Promise<LoyaltyTransaction[]> {
  const { data, error } = await supabase
    .from('loyalty_transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getRewards(tier: LoyaltyTier): Promise<Reward[]> {
  const tierOrder: LoyaltyTier[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond']
  const eligibleTiers = tierOrder.slice(0, tierOrder.indexOf(tier) + 1)

  const { data, error } = await supabase
    .from('rewards')
    .select('*')
    .in('tier_required', eligibleTiers)
    // Retired rewards must never be offered. This filter was missing, so
    // deactivated rewards were still listed (and were redeemable).
    .eq('is_active', true)
    // Deterministic ordering — results were previously in arbitrary DB order.
    .order('points_cost', { ascending: true })
    .order('id', { ascending: true })

  if (error) throw new Error(error.message)
  return data ?? []
}

export interface RedemptionResult {
  redemption_id: string
  points_spent: number
  available_points: number
}

/**
 * Redeem a reward.
 *
 * This delegates entirely to the `redeem_reward` Postgres function (see
 * migrations/0003_redeem_reward_atomic.sql). That is deliberate and must stay
 * that way: the tier gate and the balance decrement have to be evaluated under
 * a row lock inside one transaction. The previous implementation did the checks
 * here in application code and was exploitable two ways —
 *
 *   - it never checked `tier_required`, so a gold user could redeem a
 *     platinum-only reward by POSTing straight to the redeem endpoint; and
 *   - it read the balance and then wrote (balance - cost), so six concurrent
 *     requests each read 8500 and each granted a 3000pt reward while the
 *     balance fell by only 3000.
 *
 * Do NOT reintroduce a read-then-write fallback here. If the function is
 * missing, this fails closed (503) rather than silently reopening the hole.
 */
export async function redeemReward(userId: string, rewardId: string): Promise<RedemptionResult> {
  const { data, error } = await supabase.rpc('redeem_reward', {
    p_user_id: userId,
    p_reward_id: rewardId,
  })

  if (error) {
    // PGRST202 = function not found in the schema cache: migration 0003 has not
    // been applied. Fail closed and say so plainly.
    if (error.code === 'PGRST202') {
      throw Object.assign(
        new Error(
          'Redemption is unavailable: the redeem_reward database function is missing. ' +
            'Apply migrations/0003_redeem_reward_atomic.sql.',
        ),
        { statusCode: 503 },
      )
    }
    throw new Error(error.message)
  }

  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('redeem_reward returned no result')

  switch (row.status) {
    case 'ok':
      return {
        redemption_id: row.redemption_id,
        points_spent: row.points_spent,
        available_points: row.available_points,
      }
    case 'reward_not_found':
      throw Object.assign(new Error('Reward not found'), { statusCode: 404 })
    case 'loyalty_not_found':
      throw Object.assign(new Error('Loyalty record not found'), { statusCode: 404 })
    case 'reward_inactive':
      throw Object.assign(new Error('This reward is no longer available'), { statusCode: 409 })
    case 'reward_expired':
      throw Object.assign(new Error('This reward has expired'), { statusCode: 409 })
    case 'out_of_stock':
      throw Object.assign(new Error('This reward is out of stock'), { statusCode: 409 })
    case 'tier_too_low':
      throw Object.assign(
        new Error(`This reward requires ${row.required_tier} tier; your tier is ${row.user_tier}`),
        { statusCode: 403 },
      )
    case 'insufficient_points':
      throw Object.assign(new Error('Insufficient points'), { statusCode: 400 })
    default:
      throw new Error(`Unexpected redemption status: ${row.status}`)
  }
}

/**
 * Total points the user has ever spent on rewards.
 *
 * Clients were deriving this as `lifetime_points - available_points`, which is
 * wrong: lifetime_points only ever counts points EARNED, and any adjustment
 * that moves available_points without a redemption (expiry, manual correction)
 * makes that subtraction drift. The redemption ledger is the real source.
 */
export async function getPointsRedeemed(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('reward_redemptions')
    .select('points_spent')
    .eq('user_id', userId)

  if (error) throw new Error(error.message)
  return (data ?? []).reduce((sum, r) => sum + (r.points_spent ?? 0), 0)
}

export async function getAchievements(userId: string): Promise<{ all: Achievement[]; earned: string[] }> {
  const [{ data: all }, { data: earned }] = await Promise.all([
    supabase.from('achievements').select('*'),
    supabase.from('user_achievements').select('achievement_id').eq('user_id', userId),
  ])

  return {
    all: all ?? [],
    earned: (earned ?? []).map((r) => r.achievement_id),
  }
}
