/**
 * Adversarial verification for migrations/0016_avatars_bucket_hardening.sql.
 *
 *   npm run verify:avatars
 *
 * Proves against live storage that (a) anon can no longer LIST the avatars
 * bucket (the member-UUID enumeration oracle), (b) the bucket carries size + MIME
 * limits, (c) a member cannot write into ANOTHER member's prefix (009 let anyone
 * overwrite anyone), while (d) a member's own upload still works.
 *
 * BEFORE 0016: anon list returns objects and cross-owner upload succeeds. AFTER:
 * anon list is empty/denied and cross-owner upload is denied. DEV ONLY; refuses
 * NODE_ENV=production; cleans up any objects and users it creates.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const URL_ = process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON = process.env.PROBE_ANON_KEY
if (!URL_ || !SERVICE) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
if (!ANON) throw new Error('Missing PROBE_ANON_KEY (browser publishable key)')

const sb = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })
let failures = 0
const pass = (m: string) => console.log(`  PASS  ${m}`)
const fail = (m: string) => { failures++; console.log(`  FAIL  ${m}`) }

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

async function listAvatars(key: string, token = key) {
  const res = await fetch(`${URL_}/storage/v1/object/list/avatars`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 100 }),
  })
  const text = await res.text()
  let body: any; try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}
async function upload(path: string, token: string) {
  const res = await fetch(`${URL_}/storage/v1/object/avatars/${path}`, {
    method: 'POST',
    headers: { apikey: ANON!, Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: PNG,
  })
  const text = await res.text()
  let body: any; try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}
const denied = (r: { status: number; body: any }) => r.status === 400 || r.status === 401 || r.status === 403
const rowsOf = (r: { status: number; body: any }) => (Array.isArray(r.body) ? r.body : [])
const describe = (r: { status: number; body: any }) => `${r.status} ${String(JSON.stringify(r.body ?? '')).slice(0, 140)}`

const created: string[] = []
const objects: string[] = []
interface U { id: string; token: string }
async function makeUser(tag: string): Promise<U> {
  const email = `verify-av-${tag}-${randomUUID()}@staunton-verify.invalid`
  const password = `Vf!${randomUUID()}`
  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser(${tag}): ${error?.message}`)
  created.push(data.user.id)
  await sb.from('profiles').upsert({ id: data.user.id, email, full_name: `Av ${tag}` }, { onConflict: 'id' })
  const c = createClient(URL_!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: s, error: sErr } = await c.auth.signInWithPassword({ email, password })
  if (sErr || !s.session) throw new Error(`signIn(${tag}): ${sErr?.message}`)
  return { id: data.user.id, token: s.session.access_token }
}
async function cleanup() {
  if (objects.length) await sb.storage.from('avatars').remove(objects).catch(() => {})
  for (const id of created) {
    await sb.storage.from('avatars').remove([`${id}/verify.png`]).catch(() => {})
    await sb.from('profiles').delete().eq('id', id)
    await sb.auth.admin.deleteUser(id).catch(() => {})
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run against production')

  // Detection: limits present => 0016 applied.
  const { data: buckets } = await sb.storage.listBuckets()
  const av: any = buckets?.find((b) => b.id === 'avatars')
  const applied = !!(av?.file_size_limit && av?.allowed_mime_types)
  console.log('\n=== STATE DETECTION ===')
  console.log(`  avatars bucket: ${JSON.stringify({ public: av?.public, file_size_limit: av?.file_size_limit, allowed_mime_types: av?.allowed_mime_types })}`)
  console.log(`  0016 (limits + hardening applied): ${applied}`)

  try {
    const alice = await makeUser('alice')
    const bob = await makeUser('bob')

    // Seed one object so anon-list "0 rows" cannot be mistaken for "empty bucket".
    const seedPath = `${alice.id}/verify.png`
    const seed = await sb.storage.from('avatars').upload(seedPath, PNG, { contentType: 'image/png', upsert: true })
    if (seed.error) console.log(`  WARN  could not seed avatar object: ${seed.error.message}`)
    else objects.push(seedPath)

    // ── size + MIME limits ───────────────────────────────────────────────────
    console.log('\n=== 0016 — BUCKET LIMITS ===')
    if (applied) {
      if (av.file_size_limit === 5242880) pass(`[set] file_size_limit = ${av.file_size_limit}`)
      else fail(`[UNEXPECTED] file_size_limit = ${av.file_size_limit} (wanted 5242880)`)
      const mimes: string[] = av.allowed_mime_types ?? []
      if (mimes.includes('image/png') && !mimes.includes('application/octet-stream')) pass(`[set] allowed_mime_types = ${JSON.stringify(mimes)}`)
      else fail(`[UNEXPECTED] allowed_mime_types = ${JSON.stringify(mimes)}`)
    } else {
      console.log('  INFO  limits not set yet (pre-0016)')
    }

    // ── anon cannot list ─────────────────────────────────────────────────────
    console.log('\n=== 0016 — ANON LISTING THE BUCKET ===')
    const anonList = await listAvatars(ANON!)
    const anonSees = rowsOf(anonList).length
    if (applied) {
      if (denied(anonList) || anonSees === 0) pass(`[blocked] anon list avatars -> ${anonList.status}, ${anonSees} objects`)
      else fail(`[EXPLOITABLE] anon still lists ${anonSees} objects -> ${describe(anonList)}`)
    } else {
      if (anonSees > 0) pass(`[reproduced, pre-0016] anon lists ${anonSees} objects (member UUIDs) -> ${describe(anonList)}`)
      else console.log(`  INFO  anon list returned ${anonSees} objects pre-0016 (${describe(anonList)})`)
    }

    // authenticated list should still work (proves it's anon-only, not broken)
    const authList = await listAvatars(ANON!, alice.token)
    if (authList.status >= 200 && authList.status < 300) pass(`[still works] an authenticated member can list avatars -> ${authList.status}, ${rowsOf(authList).length} objects`)
    else fail(`[BROKE] authenticated list failed -> ${describe(authList)}`)

    // ── cross-owner write — a CONTROL that must be blocked in BOTH states ─────
    // 009_avatars_storage.sql tried to loosen this to "any authenticated user",
    // but that loosening is NOT live (only 003's owner-scoped INSERT policy is),
    // so cross-owner write is already denied. 0016 re-locks it explicitly, so the
    // property must hold whether or not 0016 has been applied. This is therefore
    // a control (must always be blocked), not a reproduce-before exploit.
    console.log('\n=== 0016 — CROSS-OWNER WRITE (must be blocked either way) ===')
    const cross = await upload(`${bob.id}/verify-hack.png`, alice.token)
    if (denied(cross)) pass(`[blocked] alice writes into bob's prefix -> ${describe(cross)}`)
    else { fail(`[EXPLOITABLE] alice wrote into bob's prefix -> ${describe(cross)}`); objects.push(`${bob.id}/verify-hack.png`) }

    // owner upload still works
    const own = await upload(`${alice.id}/verify-own.png`, alice.token)
    if (own.status >= 200 && own.status < 300) { pass('[still works] a member uploads to their OWN prefix'); objects.push(`${alice.id}/verify-own.png`) }
    else fail(`[BROKE] owner upload failed -> ${describe(own)}`)
  } finally {
    await cleanup()
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (0016 ${applied ? 'applied' : 'NOT applied'})`)
  process.exitCode = failures === 0 ? 0 : 1
}
main().catch((e) => { console.error(e); cleanup().finally(() => { process.exitCode = 1 }) })
