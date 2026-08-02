/**
 * Verification for migrations/0011_subscriptions_foundation.sql.
 *
 *   npm run verify:subscriptions
 *
 * Three properties, none of which "the migration applied cleanly" demonstrates:
 *
 *   1. NOTHING IS SELLABLE YET, and the database enforces that rather than
 *      trusting the seed. An unpriced plan cannot be activated, and an inactive
 *      plan cannot be sold. If either gate is soft, a firm gets paid features
 *      for free and the first anyone knows is a revenue hole.
 *
 *   2. ENTITLEMENTS FAIL CLOSED. An org with no subscription must resolve to the
 *      BASE floor — never to full access, never to unlimited. This is the check
 *      that matters most: a resolver that opens up when its input is missing is
 *      the standard way this class of bug ships.
 *
 *   3. STATE CHANGES ARE ATOMIC. This codebase has a documented double-spend
 *      from a non-atomic read-then-write (six concurrent redemptions granted
 *      18,000pts while charging 3,000). Subscription state has the same shape,
 *      so it is tested the same way: fire concurrent changes and assert that
 *      none was lost and no duplicate row appeared.
 *
 * Plus the access posture: these tables and both RPCs must be unreachable with
 * the browser-shipped key AND with a real logged-in user token. A client-writable
 * org_subscriptions row is a self-service upgrade to any plan.
 *
 * DEV ONLY. Refuses to run with NODE_ENV=production. Creates a throwaway org,
 * a throwaway auth user and a throwaway PRICED, ACTIVE plan (the only way to
 * exercise the success path, since every seeded plan is deliberately unsellable),
 * and removes all of it on the way out, including on failure.
 *
 * Exits non-zero if any check fails.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const URL_ = process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON = process.env.PROBE_ANON_KEY

if (!URL_ || !SERVICE) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')

const sb = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

let failures = 0
const pass = (m: string) => console.log(`  PASS  ${m}`)
const fail = (m: string) => {
  failures++
  console.log(`  FAIL  ${m}`)
}
const check = (ok: boolean, m: string, detail = '') => (ok ? pass(m) : fail(`${m}${detail ? ` -> ${detail}` : ''}`))

async function rest(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON ?? token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const isDenied = (r: { status: number; body: any }) =>
  r.status === 401 ||
  r.status === 403 ||
  r.body?.code === '42501' ||
  r.body?.code === 'PGRST202' ||
  r.body?.code === 'PGRST301' ||
  /permission denied/i.test(String(r.body?.message ?? ''))

const TEMP_PLAN_KEY = `zz-verify-temp-${randomUUID().slice(0, 8)}`

let orgId: string | undefined
let userId: string | undefined
let tempPlanId: string | undefined

async function cleanup() {
  if (orgId) {
    await sb.from('subscription_events').delete().eq('org_id', orgId)
    await sb.from('org_subscriptions').delete().eq('org_id', orgId)
    await sb.from('members').delete().eq('org_id', orgId)
    await sb.from('organizations').delete().eq('id', orgId)
  }
  if (tempPlanId) {
    await sb.from('plan_entitlements').delete().eq('plan_id', tempPlanId)
    await sb.from('subscription_plans').delete().eq('id', tempPlanId)
  }
  if (userId) {
    await sb.from('profiles').delete().eq('id', userId)
    await sb.auth.admin.deleteUser(userId).catch(() => {})
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run against production')

  // ── Is 0011 applied? ──────────────────────────────────────────────────────
  const spec: any = await fetch(`${URL_}/rest/v1/`, {
    headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, Accept: 'application/openapi+json' },
  }).then((r) => r.json())

  const rpcs = Object.keys(spec?.paths ?? {})
  const applied =
    rpcs.includes('/rpc/resolve_org_entitlements') && rpcs.includes('/rpc/set_org_subscription')

  console.log('\n=== STATE DETECTION ===')
  console.log(`  resolve_org_entitlements : ${rpcs.includes('/rpc/resolve_org_entitlements')}`)
  console.log(`  set_org_subscription     : ${rpcs.includes('/rpc/set_org_subscription')}`)

  if (!applied) {
    console.log(
      '\n0011_subscriptions_foundation.sql is NOT APPLIED. Nothing to verify.\n' +
        'Apply it in the Supabase SQL editor, then run this again.',
    )
    process.exitCode = 2
    return
  }
  console.log('  => 0011 APPLIED.')

  try {
    // ── 1. The seed is not sellable ─────────────────────────────────────────
    console.log('\n=== 1. NOTHING IS SELLABLE, AND NO PRICE IS INVENTED ===')

    const { data: bases } = await sb.from('subscription_plans').select('key').eq('is_base', true)
    check((bases ?? []).length === 1, 'exactly one base plan exists', JSON.stringify(bases))

    const { data: bad } = await sb
      .from('subscription_plans')
      .select('key, price_amount, is_active')
      .eq('is_base', false)
      .or('is_active.eq.true,price_amount.not.is.null')
    check(
      (bad ?? []).length === 0,
      'no seeded paid plan is active or carries an invented price',
      JSON.stringify(bad),
    )

    // The constraint, not the seed. Attempting to activate an unpriced plan must
    // be refused by the database — otherwise "inactive" is a convention rather
    // than a guarantee, and one UPDATE in a console undoes it.
    const { error: actErr } = await sb
      .from('subscription_plans')
      .update({ is_active: true })
      .eq('key', 'desk')
    check(
      !!actErr,
      'the database REFUSES to activate a plan with no real price',
      actErr ? '' : 'the update SUCCEEDED — an unpriced plan is now sellable',
    )
    if (actErr) console.log(`        (${actErr.code} ${actErr.message.slice(0, 90)})`)

    // ── Fixtures ────────────────────────────────────────────────────────────
    const { data: org, error: oErr } = await sb
      .from('organizations')
      .insert({
        legal_name: `Verify Subs ${randomUUID().slice(0, 8)}`,
        jurisdiction: 'NL',
        status: 'approved',
        lane: 'principal',
      })
      .select('id')
      .single()
    if (oErr) throw new Error(`org insert failed: ${oErr.message}`)
    orgId = org.id

    // ── 2. Fail-closed resolution ───────────────────────────────────────────
    console.log('\n=== 2. ENTITLEMENTS FAIL CLOSED ===')

    const { data: ent0, error: e0 } = await sb.rpc('resolve_org_entitlements', { p_org: orgId })
    if (e0) throw new Error(`resolve failed: ${e0.message}`)

    const rows = (ent0 ?? []) as { key: string; value: any; source: string }[]
    check(rows.length > 0, 'an org with NO subscription still resolves the base floor')
    check(
      rows.every((r) => r.source === 'base'),
      'every resolved entitlement comes from the base plan',
      JSON.stringify(rows.filter((r) => r.source !== 'base')),
    )

    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    // The specific fail-closed assertions. A resolver bug would most likely show
    // up as a paid feature being on, or a limit being null (= unlimited), for a
    // firm that pays nothing.
    check(byKey.get('report.export')?.value === false, 'report.export is FALSE with no subscription')
    check(byKey.get('api.access')?.value === false, 'api.access is FALSE with no subscription')
    check(byKey.get('voice.rooms')?.value === false, 'voice.rooms is FALSE with no subscription')
    const dealCap = byKey.get('deals.active_max')
    check(
      dealCap?.value !== null && typeof dealCap?.value === 'number',
      'deals.active_max is a FINITE number, not unlimited',
      JSON.stringify(dealCap),
    )

    // An org id that does not exist must not resolve to anything permissive.
    const { data: entGhost } = await sb.rpc('resolve_org_entitlements', {
      p_org: '00000000-0000-0000-0000-000000000000',
    })
    const ghost = (entGhost ?? []) as { source: string }[]
    check(
      ghost.every((r) => r.source === 'base'),
      'a nonexistent org resolves to base only, never to plan entitlements',
      JSON.stringify(ghost.filter((r) => r.source !== 'base')),
    )

    // ── 3. Selling an inactive plan is refused ──────────────────────────────
    console.log('\n=== 3. AN UNPRICED PLAN CANNOT BE SOLD ===')
    const { data: sellSeeded } = await sb.rpc('set_org_subscription', {
      p_org: orgId,
      p_plan_key: 'desk',
      p_status: 'active',
    })
    const sellRow = Array.isArray(sellSeeded) ? sellSeeded[0] : sellSeeded
    check(
      sellRow?.status_out === 'plan_inactive',
      "subscribing to the seeded 'desk' plan is refused with plan_inactive",
      JSON.stringify(sellRow),
    )

    // ── 4. Atomicity ────────────────────────────────────────────────────────
    // Needs a sellable plan, and by design none exists — so make a throwaway one
    // with a real price. This is the only place a success path can be exercised.
    console.log('\n=== 4. CONCURRENT STATE CHANGES ARE ATOMIC ===')

    const { data: tempPlan, error: tpErr } = await sb
      .from('subscription_plans')
      .insert({
        key: TEMP_PLAN_KEY,
        name: 'Verify Temp (throwaway)',
        price_amount: 1,
        is_placeholder_pricing: false,
        is_active: true,
        sort_order: 999,
      })
      .select('id')
      .single()
    if (tpErr) throw new Error(`temp plan insert failed: ${tpErr.message}`)
    tempPlanId = tempPlan.id

    // Six concurrent FIRST-TIME subscribes for one org. org_id is the primary
    // key, so the strongest possible assertion is available: exactly one row.
    const CONCURRENCY = 6
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        sb.rpc('set_org_subscription', {
          p_org: orgId,
          p_plan_key: TEMP_PLAN_KEY,
          p_status: 'active',
          p_reason: 'concurrency probe',
        }),
      ),
    )
    const outcomes = results.map((r) => {
      const row = Array.isArray(r.data) ? r.data[0] : r.data
      return r.error ? `error:${r.error.code}` : row?.status_out
    })
    console.log(`        outcomes: ${JSON.stringify(outcomes)}`)

    const { data: liveRows } = await sb.from('org_subscriptions').select('org_id, version').eq('org_id', orgId)
    check(
      (liveRows ?? []).length === 1,
      `${CONCURRENCY} concurrent subscribes produced exactly ONE subscription row`,
      `got ${(liveRows ?? []).length}`,
    )
    const okCount = outcomes.filter((o) => o === 'ok').length
    const unchangedCount = outcomes.filter((o) => o === 'unchanged').length
    check(
      okCount === 1,
      `exactly one caller was told 'ok' (the rest saw the settled state)`,
      `ok=${okCount} unchanged=${unchangedCount}`,
    )
    check(
      okCount + unchangedCount + outcomes.filter((o) => o === 'concurrent_modification').length ===
        CONCURRENCY,
      'every concurrent caller got a defined outcome (none errored)',
      JSON.stringify(outcomes),
    )

    // No lost updates across a run of distinct changes: version must advance by
    // exactly the number of changes that actually applied, and the audit log
    // must have one row per applied change.
    const before = (liveRows ?? [])[0]?.version ?? 0
    const CHANGES = 5
    for (let i = 0; i < CHANGES; i++) {
      await sb.rpc('set_org_subscription', {
        p_org: orgId,
        p_plan_key: i % 2 === 0 ? 'base' : TEMP_PLAN_KEY,
        p_status: i % 2 === 0 ? 'canceled' : 'active',
        p_reason: `sequence ${i}`,
      })
    }
    const { data: afterRow } = await sb
      .from('org_subscriptions')
      .select('version')
      .eq('org_id', orgId)
      .single()
    check(
      afterRow?.version === before + CHANGES,
      `version advanced by exactly ${CHANGES} — no update was lost`,
      `before=${before} after=${afterRow?.version}`,
    )

    const { count: evCount } = await sb
      .from('subscription_events')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
    check(
      (evCount ?? 0) === 1 + CHANGES,
      `the audit log has exactly one row per applied change (${1 + CHANGES})`,
      `got ${evCount}`,
    )

    // ── 5. A granting subscription actually overlays ─────────────────────────
    console.log('\n=== 5. A GRANTING PLAN OVERLAYS THE BASE FLOOR ===')
    await sb.from('plan_entitlements').insert({
      plan_id: tempPlanId,
      key: 'report.export',
      value: { type: 'boolean', value: true },
    })
    await sb.rpc('set_org_subscription', {
      p_org: orgId,
      p_plan_key: TEMP_PLAN_KEY,
      p_status: 'active',
    })
    const { data: entPaid } = await sb.rpc('resolve_org_entitlements', { p_org: orgId })
    const paidMap = new Map(((entPaid ?? []) as any[]).map((r) => [r.key, r]))
    check(
      paidMap.get('report.export')?.value?.value === true &&
        paidMap.get('report.export')?.source === 'plan',
      'an active plan overrides a base entitlement, and is reported as source=plan',
      JSON.stringify(paidMap.get('report.export')),
    )
    check(
      paidMap.get('support.tier')?.source === 'base',
      'keys the plan does not override still come through from base',
      JSON.stringify(paidMap.get('support.tier')),
    )

    // past_due must NOT grant — the commercial decision written into the SQL.
    await sb.from('org_subscriptions').update({ status: 'past_due' }).eq('org_id', orgId)
    const { data: entPastDue } = await sb.rpc('resolve_org_entitlements', { p_org: orgId })
    const pdMap = new Map(((entPastDue ?? []) as any[]).map((r) => [r.key, r]))
    check(
      pdMap.get('report.export')?.value?.value === false,
      "a 'past_due' subscription falls back to base (does not keep paid features)",
      JSON.stringify(pdMap.get('report.export')),
    )

    // ── 6. Nothing is client-reachable ──────────────────────────────────────
    console.log('\n=== 6. BACKEND-ONLY: NOT REACHABLE FROM A BROWSER ===')

    if (!ANON) {
      console.log('  SKIP  PROBE_ANON_KEY not set — cannot test the browser-shipped key')
    } else {
      // A real logged-in user, because "authenticated" is the role that matters:
      // anon being blocked proves little if every member can read the table.
      const email = `verify-subs-${randomUUID()}@staunton-verify.invalid`
      const password = `Vf!${randomUUID()}`
      const { data: u, error: uErr } = await sb.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (uErr || !u.user) throw new Error(`createUser failed: ${uErr?.message}`)
      userId = u.user.id
      await sb.from('profiles').upsert({ id: userId, email, full_name: 'Verify Subs' }, { onConflict: 'id' })

      const anonClient = createClient(URL_!, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
      const { data: sess } = await anonClient.auth.signInWithPassword({ email, password })
      const userToken = sess?.session?.access_token

      for (const table of [
        'subscription_plans',
        'plan_entitlements',
        'org_subscriptions',
        'subscription_events',
      ]) {
        const asAnon = await rest(`${table}?select=*&limit=1`, ANON)
        check(isDenied(asAnon), `anon cannot read ${table}`, JSON.stringify(asAnon.body).slice(0, 120))

        if (userToken) {
          const asUser = await rest(`${table}?select=*&limit=1`, userToken)
          check(
            isDenied(asUser),
            `an authenticated member cannot read ${table} directly`,
            JSON.stringify(asUser.body).slice(0, 120),
          )
        }
      }

      // The self-service upgrade: writing your own subscription row.
      if (userToken) {
        const selfUpgrade = await rest('org_subscriptions', userToken, {
          method: 'POST',
          body: JSON.stringify({ org_id: orgId, plan_id: tempPlanId, status: 'active' }),
        })
        check(
          isDenied(selfUpgrade),
          'an authenticated member cannot write their own org_subscriptions row (self-service upgrade)',
          JSON.stringify(selfUpgrade.body).slice(0, 140),
        )

        for (const fn of ['resolve_org_entitlements', 'set_org_subscription']) {
          const r = await rest(`rpc/${fn}`, userToken, {
            method: 'POST',
            body: JSON.stringify({ p_org: orgId, p_plan_key: 'base', p_status: 'active' }),
          })
          check(isDenied(r), `an authenticated member cannot call ${fn}`, JSON.stringify(r.body).slice(0, 140))
        }
      }
    }
  } finally {
    await cleanup()
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  // exitCode rather than process.exit(): an abrupt exit while the Supabase
  // client still holds handles trips a libuv assertion on Windows, which would
  // mask the real exit status this script exists to report.
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  cleanup().finally(() => {
    process.exitCode = 1
  })
})
