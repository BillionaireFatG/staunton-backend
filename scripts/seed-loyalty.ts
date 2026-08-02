/**
 * Dev seed: loyalty sample data.
 *
 *   npm run seed:loyalty                       # seeds the default dev account
 *   SEED_USER_EMAIL=someone@example.com npm run seed:loyalty
 *
 * Why this exists: `user_loyalty`, `loyalty_transactions` and `reward_redemptions`
 * ship empty, so `getUserLoyalty()` 404s for every user and no loyalty endpoint has
 * ever been exercised end to end. This puts one realistic row in place so the tier
 * maths, the reward tier-gate and the redemption flow can actually be smoke-tested.
 *
 * Properties:
 *   - IDEMPOTENT. Re-running restores the sample row to exactly the values below,
 *     which also makes it the "reset" button between redemption tests.
 *   - ADDITIVE. It never drops, truncates or deletes anything. Redemption rows
 *     created by testing are left alone; clean those up by hand if you care.
 *   - DEV ONLY. Refuses to run when NODE_ENV=production, and every row it writes is
 *     labelled with DEV_LABEL so it is obvious in the dashboard.
 *
 * All data below is fabricated sample data. It is not a real trading record.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const DEV_LABEL = '[DEV SAMPLE]'

/** Default dev account to attach loyalty to. Must already exist in auth.users. */
const DEFAULT_SEED_EMAIL = 'ryan.amir.cherkaoui@gmail.com'

/**
 * Fixed UUIDs so re-running upserts the same rows instead of piling up duplicates.
 * The `5eed…` prefix marks them as seed data at a glance.
 */
const TX_IDS = [
  '5eed10a1-0000-4000-8000-000000000001',
  '5eed10a1-0000-4000-8000-000000000002',
  '5eed10a1-0000-4000-8000-000000000003',
  '5eed10a1-0000-4000-8000-000000000004',
  '5eed10a1-0000-4000-8000-000000000005',
  '5eed10a1-0000-4000-8000-000000000006',
]

/**
 * An INACTIVE reward. `getRewards()` does not filter on `is_active`, so this row
 * shows up in `GET /api/loyalty/rewards` for any bronze-or-above user — which is the
 * point: it makes that bug observable instead of theoretical. Delete this row (id
 * below) once `is_active` filtering lands.
 */
const INACTIVE_REWARD_ID = '5eed0000-0000-4000-8000-000000000001'

/**
 * Lands the account in GOLD: thresholds are bronze 0 / silver 1000 / gold 5000 /
 * platinum 15000 / diamond 50000, and tier is derived from lifetime_points.
 *   progress to platinum = (12000 - 5000) / (15000 - 5000) = 70%
 * available_points sits well below lifetime so redemptions are affordable while the
 * spent/earned gap stays visible, and so tier can be observed NOT moving when points
 * are spent.
 */
const LOYALTY_SAMPLE = {
  tier: 'gold' as const,
  total_points: 12000,
  available_points: 8500,
  lifetime_points: 12000,
  deals_completed: 14,
  total_volume_usd: 4_250_000,
  current_streak: 3,
  longest_streak: 7,
  tier_progress: 70,
  next_tier_threshold: 15000,
}

const TRANSACTIONS = [
  { points: 5000, transaction_type: 'deal_completed', description: `${DEV_LABEL} Cargo settled — 30kt HSFO, Fujairah`, reference_type: 'deal' },
  { points: 2500, transaction_type: 'deal_completed', description: `${DEV_LABEL} Cargo settled — 12kt copper cathode, Rotterdam`, reference_type: 'deal' },
  { points: 2000, transaction_type: 'volume_bonus', description: `${DEV_LABEL} Quarterly volume bonus (Q2)`, reference_type: null },
  { points: 1500, transaction_type: 'referral', description: `${DEV_LABEL} Referred counterparty completed vetting`, reference_type: 'profile' },
  { points: 1000, transaction_type: 'achievement', description: `${DEV_LABEL} Achievement unlocked — Trusted Trader`, reference_type: 'achievement' },
  { points: -3500, transaction_type: 'redeemed', description: `${DEV_LABEL} Redeemed — Featured Listing`, reference_type: 'reward' },
]

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-loyalty is dev-only and refuses to run with NODE_ENV=production')
  }

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')

  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const email = process.env.SEED_USER_EMAIL ?? DEFAULT_SEED_EMAIL

  console.log(`Seeding loyalty sample data against ${new URL(url).host}`)

  // Resolve a REAL auth user. user_loyalty.user_id FKs to auth.users, so an invented
  // UUID would be rejected; resolving by email keeps the script portable across envs.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .eq('email', email)
    .single()

  if (profileError || !profile) {
    throw new Error(`No profile found for ${email}. Pass SEED_USER_EMAIL=<an existing dev account>.`)
  }

  const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(profile.id)
  if (authError || !authUser?.user) {
    throw new Error(`Profile ${profile.id} has no matching auth.users row; the FK would reject it.`)
  }

  const userId = authUser.user.id
  console.log(`  user: ${profile.full_name ?? '(no name)'} <${profile.email}>  ${userId}`)

  // --- user_loyalty (user_id is UNIQUE, so onConflict upsert is safe) ------------
  const { data: loyalty, error: loyaltyError } = await supabase
    .from('user_loyalty')
    .upsert(
      { user_id: userId, ...LOYALTY_SAMPLE, tier_updated_at: daysAgo(21), joined_at: daysAgo(180), updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
    .select()
    .single()

  if (loyaltyError) throw new Error(`user_loyalty upsert failed: ${loyaltyError.message}`)
  console.log(`  user_loyalty: tier=${loyalty.tier} lifetime=${loyalty.lifetime_points} available=${loyalty.available_points}`)

  // --- loyalty_transactions (fixed ids -> upsert on primary key) -----------------
  const txRows = TRANSACTIONS.map((tx, i) => ({
    id: TX_IDS[i],
    user_id: userId,
    points: tx.points,
    transaction_type: tx.transaction_type,
    description: tx.description,
    reference_id: null,
    reference_type: tx.reference_type,
    created_at: daysAgo((i + 1) * 9),
  }))

  const { data: txs, error: txError } = await supabase
    .from('loyalty_transactions')
    .upsert(txRows, { onConflict: 'id' })
    .select()

  if (txError) throw new Error(`loyalty_transactions upsert failed: ${txError.message}`)
  console.log(`  loyalty_transactions: ${txs.length} rows`)

  // --- one inactive reward, to make the missing is_active filter observable ------
  const { error: rewardError } = await supabase.from('rewards').upsert(
    {
      id: INACTIVE_REWARD_ID,
      name: `${DEV_LABEL} Retired Perk`,
      description: 'Inactive on purpose. If this appears in GET /api/loyalty/rewards, getRewards() is not filtering is_active.',
      points_cost: 750,
      category: 'service',
      tier_required: 'bronze',
      icon: null,
      is_active: false,
      quantity_available: null,
      expires_at: null,
    },
    { onConflict: 'id' },
  )

  if (rewardError) throw new Error(`rewards upsert failed: ${rewardError.message}`)
  console.log(`  rewards: 1 inactive ${DEV_LABEL} row (id ${INACTIVE_REWARD_ID})`)

  console.log('\nDone. Re-run to reset available_points after redemption tests.')
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`)
  process.exit(1)
})
