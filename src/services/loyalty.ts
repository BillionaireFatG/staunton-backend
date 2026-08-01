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

export async function getUserLoyalty(userId: string): Promise<LoyaltyState & { tier: LoyaltyTier; progress: ReturnType<typeof getTierProgress> }> {
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
  return { ...data, tier, progress }
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

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function redeemReward(userId: string, rewardId: string): Promise<void> {
  const loyalty = await getUserLoyalty(userId)

  const { data: reward, error: rewardError } = await supabase
    .from('rewards')
    .select('*')
    .eq('id', rewardId)
    .single()

  if (rewardError || !reward) throw Object.assign(new Error('Reward not found'), { statusCode: 404 })
  if (loyalty.available_points < reward.points_cost) throw Object.assign(new Error('Insufficient points'), { statusCode: 400 })

  const { error } = await supabase.from('reward_redemptions').insert({
    user_id: userId,
    reward_id: rewardId,
    points_spent: reward.points_cost,
    status: 'pending',
  })

  if (error) throw new Error(error.message)

  // Spend from the redeemable balance only; lifetime_points (tier) is untouched.
  await supabase
    .from('user_loyalty')
    .update({ available_points: loyalty.available_points - reward.points_cost })
    .eq('user_id', userId)
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
