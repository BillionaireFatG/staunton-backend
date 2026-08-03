/**
 * Adversarial verification for migrations/0015_deals_write_lockdown.sql.
 *
 *   npm run verify:deals
 *
 * Proves, with a REAL authenticated party token against the live database, that
 * a deal party can no longer reprice / mass-assign / fabricate a deal directly,
 * while the backend service write path and client READS still work.
 *
 * BEFORE 0015 every exploit must REPRODUCE (client writes succeed). AFTER, every
 * exploit must be DENIED (42501) with the stored row unchanged, and the backend
 * (service-role) createDeal/updateDeal must still succeed. The pair is evidence;
 * a migration that merely "ran" is not (0005 shipped inert that way).
 *
 * DEV ONLY. Refuses NODE_ENV=production. Creates two throwaway users + one deal
 * and removes them on the way out.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { createDeal, updateDeal, getDeals } from '../src/services/deals'

const URL_ = process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON = process.env.PROBE_ANON_KEY
if (!URL_ || !SERVICE) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
if (!ANON) throw new Error('Missing PROBE_ANON_KEY (browser publishable key)')

const sb = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })
let failures = 0
const pass = (m: string) => console.log(`  PASS  ${m}`)
const fail = (m: string) => { failures++; console.log(`  FAIL  ${m}`) }

async function rest(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON!, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}
const isDenied = (r: { status: number; body: any }) =>
  r.status === 401 || r.status === 403 || r.body?.code === '42501' || r.body?.code === 'PGRST301' ||
  /permission denied/i.test(String(r.body?.message ?? ''))
const rows = (r: { status: number; body: any }) => (Array.isArray(r.body) ? r.body : [])
const ok2xx = (r: { status: number; body: any }) => r.status >= 200 && r.status < 300
const describe = (r: { status: number; body: any }) =>
  `${r.status} ${r.body?.code ?? ''} ${String(r.body?.message ?? JSON.stringify(r.body ?? '')).slice(0, 110)}`

const created: string[] = []
const deals: string[] = []
interface U { id: string; email: string; token: string }
async function makeUser(tag: string): Promise<U> {
  const email = `verify-deal-${tag}-${randomUUID()}@staunton-verify.invalid`
  const password = `Vf!${randomUUID()}`
  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser(${tag}): ${error?.message}`)
  created.push(data.user.id)
  const { error: pErr } = await sb.from('profiles').upsert({ id: data.user.id, email, full_name: `Deal ${tag}` }, { onConflict: 'id' })
  if (pErr) throw new Error(`profile(${tag}): ${pErr.message}`)
  const c = createClient(URL_!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: s, error: sErr } = await c.auth.signInWithPassword({ email, password })
  if (sErr || !s.session) throw new Error(`signIn(${tag}): ${sErr?.message}`)
  return { id: data.user.id, email, token: s.session.access_token }
}
async function cleanup() {
  for (const d of deals) {
    await sb.from('deal_events').delete().eq('deal_id', d)
    await sb.from('deals').delete().eq('id', d)
  }
  for (const id of created) {
    await sb.from('deals').delete().or(`buyer_id.eq.${id},seller_id.eq.${id},created_by.eq.${id}`)
    await sb.from('profiles').delete().eq('id', id)
    await sb.auth.admin.deleteUser(id).catch(() => {})
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run against production')

  try {
    const alice = await makeUser('buyer')
    const bob = await makeUser('seller')

    // Legit backend write path (service role) — also gives us a deal to attack.
    console.log('\n=== BACKEND SERVICE WRITE PATH (must always work) ===')
    let dealId: string
    try {
      const deal = await createDeal({
        buyer_id: alice.id, seller_id: bob.id, commodity_type: 'fuel_diesel',
        quantity: 1000, unit_price: 900, delivery_location: 'ARA', created_by: alice.id,
      })
      dealId = deal.id
      deals.push(dealId)
      pass(`[still works] backend createDeal() -> ${dealId} (unit_price=${deal.unit_price}, status=${deal.status})`)
      const upd = await updateDeal(dealId, alice.id, { status: 'pending' })
      if (upd.status === 'pending') pass('[still works] backend updateDeal() sets status')
      else fail(`[BROKE] backend updateDeal returned status=${upd.status}`)

      // Counterparty hydration (server-side join; replaces the frontend embed
      // that 0012 blocks). Must return the subset, never email.
      const list = await getDeals(alice.id, { limit: 5 })
      const hydrated = list.find((d) => d.id === dealId)
      if (hydrated?.buyer?.id === alice.id && hydrated?.seller?.id === bob.id && hydrated?.seller?.full_name)
        pass(`[still works] getDeals hydrates counterparties (seller=${hydrated.seller.full_name}, no email field=${!('email' in (hydrated.seller as object))})`)
      else fail(`[BROKE] getDeals did not hydrate buyer/seller: ${JSON.stringify({ buyer: hydrated?.buyer, seller: hydrated?.seller })}`)
    } catch (e: any) {
      fail(`[BROKE] backend deal write path threw: ${e?.message}`)
      throw e
    }

    // Detect applied state: a benign client UPDATE (notes) by a party.
    const detect = await rest(`deals?id=eq.${dealId}`, alice.token, {
      method: 'PATCH', body: JSON.stringify({ notes: `detect-${Date.now()}` }), headers: { Prefer: 'return=representation' },
    })
    const applied = isDenied(detect)
    console.log('\n=== STATE DETECTION ===')
    console.log(`  0015 (client deal writes revoked): ${applied}   [party notes PATCH -> ${describe(detect)}]`)

    const before = (await sb.from('deals').select('unit_price,status,reference_number').eq('id', dealId).single()).data

    // ── Reprice / mass-assign attempts by a REAL party ───────────────────────
    console.log('\n=== 0015 — REPRICE / MASS-ASSIGN BY A PARTY ===')
    const attacks: Array<[string, object]> = [
      ['unit_price -> 1 (reprice)', { unit_price: 1 }],
      ['status -> completed', { status: 'completed' }],
      ['reference_number -> forged', { reference_number: 'STN-FORGED-0001' }],
      ['progress_percentage -> 100', { progress_percentage: 100 }],
      ['seller_id -> self (swap counterparty)', { seller_id: alice.id }],
    ]
    for (const [label, patch] of attacks) {
      const r = await rest(`deals?id=eq.${dealId}`, alice.token, {
        method: 'PATCH', body: JSON.stringify(patch), headers: { Prefer: 'return=representation' },
      })
      if (applied) {
        if (isDenied(r)) pass(`[blocked] party PATCH ${label} -> ${describe(r)}`)
        else fail(`[EXPLOITABLE] party PATCH ${label} NOT blocked -> ${describe(r)}`)
      } else {
        if (isDenied(r)) fail(`[no repro] ${label} already denied pre-0015 (${describe(r)}) — investigate`)
        else pass(`[reproduced, pre-0015] party PATCH ${label} succeeded -> ${describe(r)}`)
      }
    }
    // ground truth: after the (denied) attempts, the stored spine must be intact
    const after = (await sb.from('deals').select('unit_price,status,reference_number').eq('id', dealId).single()).data
    if (applied) {
      if (after?.unit_price == before?.unit_price && after?.status === before?.status && after?.reference_number === before?.reference_number)
        pass(`[ground truth] deal spine unchanged after attempts (unit_price=${after?.unit_price}, status=${after?.status})`)
      else fail(`[ground truth] DEAL MUTATED despite denials: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    } else {
      console.log(`  INFO  ground truth after attempts (pre-0015): ${JSON.stringify(after)}`)
      // restore for cleanliness
      await sb.from('deals').update({ unit_price: 900, status: 'pending', reference_number: before?.reference_number }).eq('id', dealId)
    }

    // ── Fabricate a deal naming another firm ─────────────────────────────────
    console.log('\n=== 0015 — FABRICATE A DEAL ONTO ANOTHER PARTY ===')
    const fab = await rest('deals', alice.token, {
      method: 'POST',
      body: JSON.stringify({
        buyer_id: alice.id, seller_id: bob.id, created_by: alice.id, commodity_type: 'fuel_diesel',
        quantity: 5, unit_price: 1, delivery_location: 'ARA', status: 'completed', progress_percentage: 100,
      }),
      headers: { Prefer: 'return=representation' },
    })
    if (applied) {
      if (isDenied(fab)) pass(`[blocked] party fabricates a deal -> ${describe(fab)}`)
      else { fail(`[EXPLOITABLE] party fabricated a deal -> ${describe(fab)}`); for (const d of rows(fab)) if (d.id) deals.push(d.id) }
    } else {
      if (isDenied(fab)) fail(`[no repro] fabricate already denied pre-0015 (${describe(fab)})`)
      else { pass(`[reproduced, pre-0015] party fabricated a deal -> ${describe(fab)}`); for (const d of rows(fab)) if (d.id) deals.push(d.id) }
    }

    // ── Reads must be unaffected ─────────────────────────────────────────────
    console.log('\n=== REGRESSION — a party still READS their own deals ===')
    const read = await rest(`deals?select=id,unit_price,status&id=eq.${dealId}`, alice.token)
    if (ok2xx(read) && rows(read).length === 1) pass(`[still works] party reads own deal -> ${describe(read)}`)
    else fail(`[BROKE] party cannot read own deal: ${describe(read)}`)
  } finally {
    await cleanup()
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exitCode = failures === 0 ? 0 : 1
}
main().catch((e) => { console.error(e); cleanup().finally(() => { process.exitCode = 1 }) })
