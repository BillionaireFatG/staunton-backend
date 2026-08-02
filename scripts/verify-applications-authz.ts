/**
 * Live security verification for the public application funnel.
 *
 *   npm run verify:applications
 *
 * This is the regression harness for the two application-funnel bugs:
 *
 *   1. `GET /api/applications/:orgId` served an organization at ANY status, so
 *      an org UUID was enough to read an approved member firm's beneficial
 *      owners (name, DOB, nationality, ownership %), member emails and
 *      documents.  (commit dbb3723)
 *   2. Every `/:orgId/*` route treated the org UUID in the path as proof of
 *      ownership. It is an identifier, not a secret. Now gated on a signed,
 *      expiring, org-bound token minted by `POST /api/applications`.
 *
 * It drives the REAL routes through `app.inject()` rather than calling services
 * directly, because the token check is a route hook — a service-level test
 * cannot see it, and "the hook is wired to every route that needs it" is
 * precisely the property that matters here.
 *
 * DEV ONLY. Refuses to run with NODE_ENV=production. It writes real rows into
 * `organizations` / `members` / `beneficial_owners` and deletes them again on
 * the way out (including on failure).
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { buildApp } from '../src/app'
import { DRAFT_TOKEN_HEADER, issueDraftToken, DRAFT_TOKEN_TTL_SECONDS } from '../src/lib/draftToken'

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

/** Assert a response's status and, when given, its machine-readable code. */
function expect(label: string, res: { statusCode: number; body: string }, status: number, code?: string) {
  let body: any = {}
  try {
    body = JSON.parse(res.body)
  } catch {
    /* empty body (204) */
  }
  const codeOk = code === undefined || body?.code === code
  if (res.statusCode === status && codeOk) {
    pass(`${label} -> ${status}${code ? ` ${code}` : ''}`)
  } else {
    fail(
      `${label} -> expected ${status}${code ? ` ${code}` : ''}, got ${res.statusCode}` +
        `${body?.code ? ` ${body.code}` : ''} ${res.body.slice(0, 200)}`,
    )
  }
  return body
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run against production')
  }

  const app = buildApp({ logger: false, disableRateLimit: true })
  await app.ready()

  const created: string[] = []
  const cleanup = async () => {
    for (const orgId of created) {
      await sb.from('beneficial_owners').delete().eq('org_id', orgId)
      await sb.from('members').delete().eq('org_id', orgId)
      await sb.from('organizations').delete().eq('id', orgId)
    }
  }

  try {
    // ── Setup: two independent applications ────────────────────────────────
    console.log('\nStarting two applications through the real route')

    const startOne = async (name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/applications',
        payload: {
          legal_name: name,
          jurisdiction: 'CH',
          primary_contact: { email: `sec-${Date.now()}@example.invalid`, full_name: 'Sec Test' },
        },
      })

    const resA = await startOne('[SEC TEST] Victim Firm A')
    const victim = expect('POST /api/applications (victim)', resA, 201)
    const resB = await startOne('[SEC TEST] Attacker Firm B')
    const attacker = expect('POST /api/applications (attacker)', resB, 201)
    created.push(victim.orgId, attacker.orgId)

    if (typeof victim.token === 'string' && victim.token.startsWith('stad1.')) {
      pass('start response carries a signed draft token + expiresAt')
    } else {
      fail(`start response is missing a token: ${JSON.stringify(victim)}`)
    }

    // Put real PII on the victim, so a leak is unmistakable in the output.
    await sb.from('beneficial_owners').insert({
      org_id: victim.orgId,
      full_name: 'Jane Q Beneficial',
      dob: '1970-01-01',
      nationality: 'CH',
      ownership_pct: 51,
    })

    const withToken = (token?: string) => (token ? { [DRAFT_TOKEN_HEADER]: token } : {})
    const get = (orgId: string, token?: string) =>
      app.inject({ method: 'GET', url: `/api/applications/${orgId}`, headers: withToken(token) })

    // ── 1. Read path ───────────────────────────────────────────────────────
    console.log('\n1. GET /api/applications/:orgId — the read IDOR')

    expect('  no token at all', await get(victim.orgId), 401, 'draft_token_missing')
    expect(
      "  attacker's own valid token, victim's org id",
      await get(victim.orgId, attacker.token),
      403,
      'draft_token_org_mismatch',
    )
    expect(
      '  tampered signature',
      await get(victim.orgId, victim.token.slice(0, -4) + 'AAAA'),
      401,
      'draft_token_invalid',
    )
    expect('  garbage token', await get(victim.orgId, 'not-a-token'), 401, 'draft_token_invalid')

    const expired = issueDraftToken(
      victim.orgId,
      new Date(Date.now() - (DRAFT_TOKEN_TTL_SECONDS + 60) * 1000),
    ).token
    expect('  expired token', await get(victim.orgId, expired), 401, 'draft_token_expired')

    const ok = expect('  correct token', await get(victim.orgId, victim.token), 200)
    if (ok?.owners?.length === 1 && ok?.org?.id === victim.orgId) {
      pass('  correct token still returns the full draft (resume works)')
    } else {
      fail(`  correct token did not return the draft: ${JSON.stringify(ok).slice(0, 200)}`)
    }

    // ── 2. Write paths ─────────────────────────────────────────────────────
    console.log('\n2. Write routes — every one was keyed on the path param alone')

    const writes: Array<[string, () => Promise<any>]> = [
      ['PATCH /:orgId/company', () =>
        app.inject({ method: 'PATCH', url: `/api/applications/${victim.orgId}/company`, payload: { legal_name: 'Pwned Ltd' } })],
      ['PATCH /:orgId/trading', () =>
        app.inject({ method: 'PATCH', url: `/api/applications/${victim.orgId}/trading`, payload: { commodities: ['x'] } })],
      ['PATCH /:orgId/principal', () =>
        app.inject({ method: 'PATCH', url: `/api/applications/${victim.orgId}/principal`, payload: { is_principal: true } })],
      ['PATCH /:orgId/history', () =>
        app.inject({ method: 'PATCH', url: `/api/applications/${victim.orgId}/history`, payload: { references: [] } })],
      ['POST  /:orgId/owners', () =>
        app.inject({ method: 'POST', url: `/api/applications/${victim.orgId}/owners`, payload: { full_name: 'Injected Owner' } })],
      ['DELETE /:orgId/owners/:id', () =>
        app.inject({ method: 'DELETE', url: `/api/applications/${victim.orgId}/owners/00000000-0000-0000-0000-000000000000` })],
      ['POST  /:orgId/members', () =>
        app.inject({ method: 'POST', url: `/api/applications/${victim.orgId}/members`, payload: { full_name: 'Mallory', email: 'm@example.invalid' } })],
      ['POST  /:orgId/submit', () =>
        app.inject({ method: 'POST', url: `/api/applications/${victim.orgId}/submit`, payload: { accepted: true, authorized: true } })],
      ['GET   /:orgId/status', () =>
        app.inject({ method: 'GET', url: `/api/applications/${victim.orgId}/status` })],
    ]
    for (const [label, run] of writes) {
      expect(`  ${label} unauthenticated`, await run(), 401, 'draft_token_missing')
    }

    // Confirm nothing above actually landed.
    const { data: after } = await sb
      .from('organizations')
      .select('legal_name, status')
      .eq('id', victim.orgId)
      .single()
    if (after?.legal_name === '[SEC TEST] Victim Firm A' && after?.status === 'draft') {
      pass('  victim org unchanged — no rejected write took effect')
    } else {
      fail(`  victim org was MODIFIED by a rejected write: ${JSON.stringify(after)}`)
    }
    const { count: ownerCount } = await sb
      .from('beneficial_owners')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', victim.orgId)
    if (ownerCount === 1) pass('  no owner injected into the victim org')
    else fail(`  beneficial_owners count is ${ownerCount}, expected 1`)

    // A valid token still lets the real applicant write.
    expect(
      '  PATCH /:orgId/company with the correct token',
      await app.inject({
        method: 'PATCH',
        url: `/api/applications/${victim.orgId}/company`,
        headers: withToken(victim.token),
        payload: { trading_name: 'Victim Trading' },
      }),
      200,
    )

    // ── 3. Live (non-draft) firms ──────────────────────────────────────────
    console.log('\n3. Non-draft organizations — the live member firm leak')

    await sb.from('organizations').update({ status: 'pending' }).eq('id', victim.orgId)

    const live = await get(victim.orgId, victim.token)
    const liveBody = expect('  GET /:orgId with a VALID token, org now pending', live, 404)
    if (!liveBody?.owners) pass('  no beneficial owners returned for a non-draft org')
    else fail(`  owners leaked for a non-draft org: ${JSON.stringify(liveBody.owners)}`)

    const status = expect(
      '  GET /:orgId/status with a valid token',
      await app.inject({
        method: 'GET',
        url: `/api/applications/${victim.orgId}/status`,
        headers: withToken(victim.token),
      }),
      200,
    )
    if (status?.status === 'pending' && !('owners' in status) && !('members' in status)) {
      pass('  status endpoint returns status only — no owners, no member emails')
    } else {
      fail(`  status endpoint projection is too wide: ${JSON.stringify(status)}`)
    }

    // ── 4. Rate limiting ───────────────────────────────────────────────────
    console.log('\n4. Rate limiting on the unauthenticated funnel')

    const limited = buildApp({ logger: false })
    await limited.ready()
    try {
      let got429 = false
      let attempts = 0
      for (let i = 0; i < 15; i++) {
        attempts++
        const res = await limited.inject({
          method: 'POST',
          url: '/api/applications/validate-invite',
          payload: { code: `BRUTE-${i}` },
        })
        if (res.statusCode === 429) {
          got429 = true
          break
        }
      }
      if (got429) pass(`  validate-invite throttled after ${attempts - 1} attempts (429 rate_limited)`)
      else fail('  validate-invite accepted 15 consecutive brute-force attempts without throttling')
    } finally {
      await limited.close()
    }
  } finally {
    await cleanup()
    await app.close()
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
