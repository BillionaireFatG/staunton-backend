/**
 * Live security verification for the reward redemption path.
 *
 *   npm run verify:redemption
 *
 * This is the regression harness for the three loyalty bugs fixed in
 * migrations/0003_redeem_reward_atomic.sql + services/loyalty.ts. It exercises
 * the real service layer against the real dev database, because the two
 * important properties here (a tier gate that holds in the WRITE path, and an
 * atomic decrement) cannot be demonstrated with mocks.
 *
 * Run `npm run seed:loyalty` first — this script resets available_points itself
 * but relies on the seeded gold-tier account and the sample rewards existing.
 *
 * DEV ONLY. Refuses to run with NODE_ENV=production. It writes real redemption
 * rows; clean them up by hand if you care about the dev data.
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import * as loyalty from '../src/services/loyalty'

const CONCURRENCY = 6

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

let failures = 0
const pass = (m: string) => console.log(`  PASS  ${m}`)
const fail = (m: string) => {
  failures++
  console.log(`  FAIL  ${m}`)
}

async function balance(userId: string): Promise<number> {
  const { data, error } = await sb.from('user_loyalty').select('available_points').eq('user_id', userId).single()
  if (error) throw new Error(error.message)
  return data.available_points
}

async function setBalance(userId: string, points: number) {
  const { error } = await sb.from('user_loyalty').update({ available_points: points }).eq('user_id', userId)
  if (error) throw new Error(error.message)
}

async function redemptionCount(userId: string): Promise<number> {
  const { count, error } = await sb
    .from('reward_redemptions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  return count ?? 0
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('verify-redemption is dev-only and refuses to run with NODE_ENV=production')
  }
  console.log(`Verifying redemption against ${new URL(url!).host}\n`)

  // Resolve the seeded loyalty account.
  const { data: rows, error } = await sb.from('user_loyalty').select('user_id, lifetime_points').limit(1)
  if (error) throw new Error(error.message)
  if (!rows?.length) throw new Error('No user_loyalty rows. Run `npm run seed:loyalty` first.')
  const userId = rows[0].user_id

  const me = await loyalty.getUserLoyalty(userId)
  console.log(`account ${userId}`)
  console.log(`tier=${me.tier} lifetime=${me.lifetime_points} available=${me.available_points}\n`)

  // Pick rewards relative to the account's actual tier.
  const tierOrder = ['bronze', 'silver', 'gold', 'platinum', 'diamond']
  const myRank = tierOrder.indexOf(me.tier)
  const { data: allRewards } = await sb.from('rewards').select('*').eq('is_active', true)
  const aboveTier = (allRewards ?? []).find((r) => tierOrder.indexOf(r.tier_required) > myRank)
  const affordable = (allRewards ?? [])
    .filter((r) => tierOrder.indexOf(r.tier_required) <= myRank)
    .sort((a, b) => b.points_cost - a.points_cost)[0]

  // ── 1. is_active filtering ────────────────────────────────────────────────
  console.log('1. getRewards() excludes inactive rewards')
  const listed = await loyalty.getRewards(me.tier)
  const inactive = listed.filter((r) => !r.is_active)
  inactive.length === 0
    ? pass(`${listed.length} rewards listed, none inactive`)
    : fail(`${inactive.length} inactive reward(s) listed: ${inactive.map((r) => r.name).join(', ')}`)

  const costs = listed.map((r) => r.points_cost)
  const sorted = [...costs].sort((a, b) => a - b)
  JSON.stringify(costs) === JSON.stringify(sorted)
    ? pass('results are deterministically ordered by points_cost')
    : fail('results are not ordered')

  // ── 2. tier gate in the WRITE path ────────────────────────────────────────
  console.log('\n2. redeem enforces tier_required (the bypass)')
  if (!aboveTier) {
    console.log('  SKIP  no reward above this account tier to test against')
  } else {
    const before = await balance(userId)
    await setBalance(userId, Math.max(before, aboveTier.points_cost + 1000))
    try {
      await loyalty.redeemReward(userId, aboveTier.id)
      fail(`${me.tier} account redeemed "${aboveTier.name}" (${aboveTier.tier_required}-only)`)
    } catch (e: any) {
      e.statusCode === 403
        ? pass(`blocked with 403: ${e.message}`)
        : fail(`blocked, but with status ${e.statusCode}: ${e.message}`)
    }
  }

  // ── 3. concurrent double-spend ────────────────────────────────────────────
  console.log(`\n3. ${CONCURRENCY} concurrent redemptions cannot overspend`)
  if (!affordable) {
    fail('no reward at or below this account tier to test against')
  } else {
    const cost = affordable.points_cost
    // Fund exactly enough for ONE redemption, so any second success is a bug.
    await setBalance(userId, cost)
    const startBal = await balance(userId)
    const startCount = await redemptionCount(userId)

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => loyalty.redeemReward(userId, affordable.id)),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const endBal = await balance(userId)
    const granted = (await redemptionCount(userId)) - startCount
    const charged = startBal - endBal

    console.log(
      `      reward="${affordable.name}" cost=${cost} funded=${startBal}`,
      `\n      succeeded=${ok}/${CONCURRENCY} redemptions_created=${granted} charged=${charged} remaining=${endBal}`,
    )

    ok === 1 ? pass('exactly one redemption succeeded') : fail(`${ok} redemptions succeeded, expected exactly 1`)
    granted === ok
      ? pass(`redemption rows (${granted}) match successes (${ok})`)
      : fail(`${granted} redemption rows for ${ok} successes — grants and charges disagree`)
    charged === granted * cost
      ? pass(`charged ${charged} for ${granted} × ${cost}`)
      : fail(`charged ${charged} but granted ${granted} × ${cost} = ${granted * cost} — DOUBLE-SPEND`)
    endBal >= 0 ? pass(`balance non-negative (${endBal})`) : fail(`balance went negative: ${endBal}`)
  }

  // ── 4. insufficient funds ─────────────────────────────────────────────────
  console.log('\n4. redeem rejects an unaffordable reward')
  if (affordable) {
    await setBalance(userId, 0)
    try {
      await loyalty.redeemReward(userId, affordable.id)
      fail('redeemed with a zero balance')
    } catch (e: any) {
      e.statusCode === 400 ? pass(`blocked with 400: ${e.message}`) : fail(`status ${e.statusCode}: ${e.message}`)
    }
  }

  console.log(
    failures === 0
      ? '\nAll redemption checks passed. Re-run `npm run seed:loyalty` to restore sample data.'
      : `\n${failures} check(s) FAILED. Re-run \`npm run seed:loyalty\` to restore sample data.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\nVerification could not run: ${err.message}`)
  process.exit(1)
})
