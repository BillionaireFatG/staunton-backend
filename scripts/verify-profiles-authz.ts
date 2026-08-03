/**
 * Adversarial verification for the profiles hardening batch:
 *   0012_profiles_pii_select_lockdown.sql   (anon PII leak + two-tier read)
 *   0013_profiles_membership_columns.sql     (member_status / member_tier)
 *   0014_profiles_write_lockdown_verification.sql (self-settable "verified")
 * plus the services/profiles.ts upsertProfile 500 regression.
 *
 *   npm run verify:profiles
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Migration 0005 shipped INERT: it ran without error, printed success, changed
 * nothing, and left the worst finding open for weeks. So "the migration applied"
 * is not the standard. This script ATTEMPTS each exploit with a real, logged-in,
 * non-privileged user token (and the browser-shipped anon key), reads ground
 * truth back with the service role, and confirms the legitimate paths still work.
 *
 * ── MEANINGFUL BEFORE *AND* AFTER ───────────────────────────────────────────
 * It detects, per migration, whether it is applied, and flips expectations:
 *   BEFORE — every exploit must REPRODUCE (proves the hole is real + visible).
 *   AFTER  — every exploit must be DENIED, and every legit op must still work.
 * Run it before applying and keep the output; run it again after. The pair is
 * the evidence.
 *
 * DEV ONLY. Refuses NODE_ENV=production. Creates throwaway auth users + profiles
 * (one plain member, one counterparty, one admin), and removes them on the way
 * out, including on failure.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { upsertProfile } from '../src/services/profiles'

const URL_ = process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON = process.env.PROBE_ANON_KEY

if (!URL_ || !SERVICE) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
if (!ANON) throw new Error('Missing PROBE_ANON_KEY (the browser publishable key from Frontend/.env.local)')

const sb = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

let failures = 0
const pass = (m: string) => console.log(`  PASS  ${m}`)
const fail = (m: string) => { failures++; console.log(`  FAIL  ${m}`) }

async function rest(path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON!, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

// 42501 permission-denied is the finding. 42703 undefined-column is a broken
// probe and must NEVER be read as a denial (this project has been bitten twice).
const isDenied = (r: { status: number; body: any }) =>
  r.status === 401 || r.status === 403 ||
  r.body?.code === '42501' || r.body?.code === 'PGRST301' || r.body?.code === 'PGRST205' ||
  /permission denied/i.test(String(r.body?.message ?? ''))
const isBadProbe = (r: { status: number; body: any }) => r.body?.code === '42703' || r.body?.code === 'PGRST204'
const rows = (r: { status: number; body: any }) => (Array.isArray(r.body) ? r.body : [])
const describe = (r: { status: number; body: any }) =>
  `${r.status} ${r.body?.code ?? ''} ${String(r.body?.message ?? JSON.stringify(r.body ?? '')).slice(0, 110)}`

const created: string[] = []
interface U { id: string; email: string; token: string }

async function makeUser(tag: string, opts: { admin?: boolean } = {}): Promise<U> {
  const email = `verify-prof-${tag}-${randomUUID()}@staunton-verify.invalid`
  const password = `Vf!${randomUUID()}`
  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser(${tag}) failed: ${error?.message}`)
  created.push(data.user.id)
  const { error: pErr } = await sb.from('profiles').upsert(
    { id: data.user.id, email, full_name: `Verify ${tag}`, is_admin: !!opts.admin },
    { onConflict: 'id' },
  )
  if (pErr) throw new Error(`profile upsert(${tag}) failed: ${pErr.message}`)
  const anonClient = createClient(URL_!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: s, error: sErr } = await anonClient.auth.signInWithPassword({ email, password })
  if (sErr || !s.session) throw new Error(`signIn(${tag}) failed: ${sErr?.message}`)
  return { id: data.user.id, email, token: s.session.access_token }
}

async function cleanup() {
  for (const id of created) {
    await sb.from('profiles').delete().eq('id', id)
    await sb.auth.admin.deleteUser(id).catch(() => {})
  }
}

async function detect() {
  const spec: any = await fetch(`${URL_}/rest/v1/`, {
    headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, Accept: 'application/openapi+json' },
  }).then((r) => r.json())
  const profCols = Object.keys(spec?.definitions?.profiles?.properties ?? {})
  const hasView = Boolean(spec?.definitions?.public_profiles)
  // anon read of profiles.email: denied => 0012 applied
  const anonEmail = await rest('profiles?select=email&limit=1', ANON!)
  const pii = isDenied(anonEmail) && hasView
  const cols = profCols.includes('member_status') && profCols.includes('member_tier')
  console.log('\n=== STATE DETECTION ===')
  console.log(`  0012 (anon PII locked + public_profiles): ${pii}   [anon email -> ${describe(anonEmail)}; view=${hasView}]`)
  console.log(`  0013 (member_status/member_tier columns): ${cols}`)
  return { pii, cols }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run against production')
  const { pii, cols } = await detect()

  try {
    const alice = await makeUser('alice')
    const bob = await makeUser('bob')
    const admin = await makeUser('admin', { admin: true })

    // ── HOLE 1: anon reads member PII ────────────────────────────────────────
    console.log('\n=== 0012 — CAN ANON READ MEMBER PII? ===')
    for (const col of ['email', 'phone', 'company_name']) {
      const r = await rest(`profiles?select=${col}&limit=3`, ANON!)
      if (pii) {
        if (isDenied(r)) pass(`[blocked] anon reads profiles.${col} -> ${describe(r)}`)
        else fail(`[EXPLOITABLE] anon still reads profiles.${col}: ${rows(r).length} rows ${describe(r)}`)
      } else {
        if (isDenied(r)) fail(`[no repro] anon.${col} already denied before 0012 (${describe(r)}) — investigate`)
        else pass(`[reproduced, pre-0012] anon reads profiles.${col}: ${rows(r).length} rows`)
      }
    }

    // ── two-tier: own full row vs another member's email ─────────────────────
    console.log('\n=== 0012 — TWO-TIER READ (own full row; others = subset, no email) ===')
    const ownRow = await rest(`profiles?select=email,full_name&id=eq.${alice.id}`, alice.token)
    if (rows(ownRow).length === 1 && rows(ownRow)[0].email === alice.email)
      pass(`[still works] member reads their OWN full row incl email -> ${describe(ownRow)}`)
    else fail(`[BROKE] member cannot read own full row: ${describe(ownRow)}`)

    const othersEmail = await rest(`profiles?select=email&id=eq.${bob.id}`, alice.token)
    const leakedEmail = rows(othersEmail).length > 0 && !!rows(othersEmail)[0]?.email
    if (pii) {
      if (!leakedEmail) pass(`[blocked] member reads 0 rows of another member's base row (email unreachable) -> ${describe(othersEmail)}`)
      else fail(`[EXPLOITABLE] member read another member's email from base table: ${describe(othersEmail)}`)
    } else {
      if (leakedEmail) pass(`[reproduced, pre-0012] member reads another member's email: ${rows(othersEmail)[0].email}`)
      else console.log(`  INFO  member sees 0 rows of other's email pre-0012 (${describe(othersEmail)})`)
    }

    // public_profiles subset (post-0012 only)
    if (pii) {
      const subset = await rest(`public_profiles?select=id,full_name,company_name&id=eq.${bob.id}`, alice.token)
      if (rows(subset).length === 1) pass(`[still works] member reads other's SUBSET via public_profiles -> ${describe(subset)}`)
      else fail(`[BROKE] member cannot read public_profiles subset of another member: ${describe(subset)}`)
      const subsetEmail = await rest(`public_profiles?select=email&id=eq.${bob.id}`, alice.token)
      if (isBadProbe(subsetEmail) || isDenied(subsetEmail))
        pass(`[blocked] public_profiles does not expose email -> ${describe(subsetEmail)}`)
      else fail(`[EXPLOITABLE] public_profiles exposed email: ${describe(subsetEmail)}`)
      const anonView = await rest('public_profiles?select=id&limit=1', ANON!)
      if (isDenied(anonView)) pass(`[blocked] anon cannot read public_profiles -> ${describe(anonView)}`)
      else fail(`[EXPLOITABLE] anon reads public_profiles: ${describe(anonView)}`)
    }

    // ── admin reads survive the lockdown (coordinator: admin #1 exists) ───────
    console.log('\n=== 0012 — ADMIN STILL READS ALL PROFILES ===')
    const adminAll = await rest(`profiles?select=id,email&limit=100`, admin.token)
    const seesOthers = rows(adminAll).some((p: any) => p.id !== admin.id)
    if (seesOthers) pass(`[still works] platform admin reads across profiles (${rows(adminAll).length} rows) -> ${describe(adminAll)}`)
    else fail(`[BROKE] platform admin cannot read other profiles after lockdown: ${describe(adminAll)}`)

    // ── 0013: membership columns ─────────────────────────────────────────────
    console.log('\n=== 0013 — member_status / member_tier ===')
    if (cols) {
      const ms = await rest(`profiles?select=member_status,member_tier&id=eq.${alice.id}`, alice.token)
      const ok = rows(ms).length === 1 && rows(ms)[0].member_status === 'none'
      if (ok) pass(`[present] member reads own member_status (default 'none') / member_tier -> ${JSON.stringify(rows(ms)[0])}`)
      else fail(`[BROKE] member_status not readable/defaulted as expected: ${describe(ms)}`)
    } else {
      console.log('  INFO  member_status/member_tier not present yet (0013 not applied)')
    }

    // ── 0014: verification_status + membership are NOT client-writable ────────
    console.log('\n=== 0014 — SELF-SETTABLE "VERIFIED" AND SELF-APPROVE ===')
    const selfVerify = await rest(`profiles?id=eq.${alice.id}`, alice.token, {
      method: 'PATCH', body: JSON.stringify({ verification_status: 'verified' }),
      headers: { Prefer: 'return=representation' },
    })
    // ground truth
    const gtVer = (await sb.from('profiles').select('verification_status').eq('id', alice.id).single()).data
    const writeLock = pii // 0014 travels with the profiles batch; use behavioral truth below
    if (isDenied(selfVerify) && gtVer?.verification_status !== 'verified') {
      pass(`[blocked] member self-sets verification_status='verified' -> ${describe(selfVerify)} (ground truth: ${gtVer?.verification_status})`)
    } else if (!isDenied(selfVerify)) {
      // reproduced pre-0014
      pass(`[reproduced, pre-0014] member self-verified: ${describe(selfVerify)} (ground truth now: ${gtVer?.verification_status})`)
      // restore
      await sb.from('profiles').update({ verification_status: 'unverified' }).eq('id', alice.id)
      if (writeLock) fail('[INCONSISTENT] profiles PII locked but verification_status still writable — apply 0014')
    } else {
      fail(`[UNCLEAR] self-verify denied but ground truth shows 'verified': ${JSON.stringify(gtVer)}`)
    }

    // is_admin self-grant — control; must be blocked in BOTH states (0010 applied)
    const selfAdmin = await rest(`profiles?id=eq.${alice.id}`, alice.token, {
      method: 'PATCH', body: JSON.stringify({ is_admin: true }), headers: { Prefer: 'return=representation' },
    })
    const gtAdmin = (await sb.from('profiles').select('is_admin').eq('id', alice.id).single()).data
    if (isDenied(selfAdmin) && gtAdmin?.is_admin !== true) pass(`[blocked] member self-grants is_admin -> ${describe(selfAdmin)}`)
    else fail(`[EXPLOITABLE] member set is_admin: ${describe(selfAdmin)} (ground truth: ${JSON.stringify(gtAdmin)})`)

    if (cols) {
      const selfApprove = await rest(`profiles?id=eq.${alice.id}`, alice.token, {
        method: 'PATCH', body: JSON.stringify({ member_status: 'approved' }), headers: { Prefer: 'return=representation' },
      })
      const gtMs = (await sb.from('profiles').select('member_status').eq('id', alice.id).single()).data
      if (isDenied(selfApprove) && gtMs?.member_status !== 'approved') pass(`[blocked] member self-approves (member_status=approved) -> ${describe(selfApprove)}`)
      else if (!isDenied(selfApprove)) { fail(`[EXPLOITABLE] member self-approved: ${describe(selfApprove)}`); await sb.from('profiles').update({ member_status: 'none' }).eq('id', alice.id) }
    }

    // ── legit self-service write must still work (bio) ────────────────────────
    console.log('\n=== REGRESSION — legitimate self-service edit ===')
    const editBio = await rest(`profiles?id=eq.${alice.id}`, alice.token, {
      method: 'PATCH', body: JSON.stringify({ bio: 'verify-bio' }), headers: { Prefer: 'return=representation' },
    })
    const gtBio = (await sb.from('profiles').select('bio').eq('id', alice.id).single()).data
    if (editBio.status >= 200 && editBio.status < 300 && gtBio?.bio === 'verify-bio')
      pass('[still works] member edits their own bio directly')
    else fail(`[BROKE] member cannot edit own bio: ${describe(editBio)} (ground truth: ${JSON.stringify(gtBio)})`)

    // ── upsertProfile 500 regression (the email-on-insert bug) ────────────────
    console.log('\n=== services/profiles.ts upsertProfile — no 500 on edit ===')
    try {
      const updated = await upsertProfile(alice.id, { full_name: 'Verify Edited', bio: 'svc-edit' })
      if (updated?.full_name === 'Verify Edited') pass('[still works] upsertProfile updates an existing profile (no NOT-NULL 500)')
      else fail(`[BROKE] upsertProfile returned unexpected row: ${JSON.stringify(updated)}`)
    } catch (e: any) {
      fail(`[BROKE] upsertProfile threw (the 500 bug): ${e?.message}`)
    }
  } finally {
    await cleanup()
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (profiles: 0012=${pii ? 'applied' : 'NOT'}, 0013=${cols ? 'applied' : 'NOT'})`)
  if (!pii) console.log('\nThis was a BEFORE run. Apply 0012–0014 in the Supabase SQL editor, then re-run — the AFTER run demonstrates the fix.')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => { console.error(e); cleanup().finally(() => { process.exitCode = 1 }) })
