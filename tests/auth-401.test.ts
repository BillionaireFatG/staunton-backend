/**
 * Auth middleware: every authenticated route rejects an anonymous caller.
 *
 * OFFLINE. `helpers/offline-env` points the Supabase client at a port nothing
 * can listen on, so this file makes no network calls and needs no credentials —
 * it is useful on a laptop with no `.env`. The bad-token cases still run the
 * REAL `authenticate`, including its `supabase.auth.getUser` call; that call
 * fails fast and the middleware's own error branch produces the 401, which is
 * exactly the branch worth pinning (a Supabase outage must read as 401, never
 * as a 500 or, worse, a pass-through).
 *
 * The route list is re-derived from src/ on every run (see helpers/routes.ts),
 * so a route added to any authenticated plugin tomorrow is covered without
 * anyone editing this file.
 */
import './helpers/offline-env'

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '../src/app'
import {
  allRoutes,
  authenticatedRoutes,
  authenticatedPrefixes,
  unauthenticatedPrefixes,
  registeredPrefixes,
  PARAM_UUID,
} from './helpers/routes'

/**
 * The prefixes that MUST be behind `authenticate`, and the ones that are
 * deliberately public. Pinned as a literal list on purpose: this is the one
 * place a human decision is recorded. Registering a new prefix — or quietly
 * dropping the auth hook from an existing one — fails here and forces the
 * decision to be made explicitly rather than by omission.
 */
const MUST_BE_AUTHENTICATED = [
  '/api/access',
  '/api/admin/vetting',
  '/api/deals',
  '/api/loyalty',
  '/api/messages',
  '/api/notifications',
  '/api/onboarding',
  '/api/profiles',
  '/api/voice-rooms',
].sort()

/**
 * The public application funnel. It is not unprotected — it is gated by a
 * signed draft token instead of a JWT (see scripts/verify-applications-authz.ts
 * and src/lib/draftToken.ts), which is why it has no `authenticate` hook.
 */
const DELIBERATELY_PUBLIC = ['/api/applications']

/** Authorization headers that must never authenticate anyone. */
const BAD_AUTH_HEADERS: Array<{ label: string; headers: Record<string, string>; message: string }> = [
  {
    label: 'no Authorization header',
    headers: {},
    message: 'Missing bearer token',
  },
  {
    label: 'empty Authorization header',
    headers: { authorization: '' },
    message: 'Missing bearer token',
  },
  {
    label: 'non-Bearer scheme (Basic)',
    headers: { authorization: 'Basic YWxhZGRpbjpvcGVuc2VzYW1l' },
    message: 'Missing bearer token',
  },
  {
    label: 'wrong-case scheme (bearer)',
    headers: { authorization: 'bearer garbage' },
    message: 'Missing bearer token',
  },
  {
    label: 'scheme with no token',
    headers: { authorization: 'Bearer' },
    message: 'Missing bearer token',
  },
  {
    label: 'malformed token (Bearer garbage)',
    headers: { authorization: 'Bearer garbage' },
    message: 'Invalid or expired token',
  },
  {
    label: 'structurally JWT-ish but unsigned token',
    headers: {
      authorization:
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdHRhY2tlciIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.',
    },
    message: 'Invalid or expired token',
  },
]

let app: FastifyInstance

before(async () => {
  app = buildApp({ logger: false, disableRateLimit: true })
  await app.ready()
})

after(async () => {
  await app?.close()
})

/** Assert the 401 contract clients depend on, and that nothing leaks with it. */
function assertUnauthorizedBody(res: { statusCode: number; body: string }, expectedMessage: string, where: string) {
  assert.equal(res.statusCode, 401, `${where}: expected 401, got ${res.statusCode} — body ${res.body.slice(0, 300)}`)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(res.body)
  } catch {
    assert.fail(`${where}: 401 body was not JSON: ${res.body.slice(0, 200)}`)
  }

  assert.equal(body.statusCode, 401, `${where}: body.statusCode`)
  assert.equal(body.error, 'Unauthorized', `${where}: body.error`)
  assert.equal(body.message, expectedMessage, `${where}: body.message`)

  // A rejection must not describe the resource it was protecting, and must not
  // carry a stack or Supabase/Postgres detail.
  assert.deepEqual(
    Object.keys(body).sort(),
    ['error', 'message', 'statusCode'],
    `${where}: 401 body carries unexpected keys — ${res.body.slice(0, 300)}`,
  )
}

// ── The enumeration itself ──────────────────────────────────────────────────
//
// A source-parsing enumeration can go blind and make every test below pass
// vacuously. These guard against that.

describe('route enumeration', () => {
  test('every registered prefix is classified as authenticated or deliberately public', () => {
    const registered = [...new Set(registeredPrefixes().map((r) => r.prefix))].sort()
    const classified = [...MUST_BE_AUTHENTICATED, ...DELIBERATELY_PUBLIC].sort()

    assert.deepEqual(
      registered,
      classified,
      'src/app.ts registers a prefix this test does not know about (or no longer registers one it expects). ' +
        'Add it to MUST_BE_AUTHENTICATED or DELIBERATELY_PUBLIC — deliberately.',
    )
  })

  test('every prefix that must be authenticated actually installs the authenticate hook', () => {
    assert.deepEqual(
      authenticatedPrefixes(),
      MUST_BE_AUTHENTICATED,
      "a prefix lost its `app.addHook('onRequest', authenticate)`",
    )
  })

  test('no prefix other than the application funnel is left without the authenticate hook', () => {
    assert.deepEqual(unauthenticatedPrefixes(), DELIBERATELY_PUBLIC)
  })

  test('the enumeration is not vacuous — every authenticated prefix yielded routes', () => {
    const routes = authenticatedRoutes()
    assert.ok(routes.length >= 50, `parser found only ${routes.length} authenticated routes; it has probably gone blind`)

    for (const prefix of MUST_BE_AUTHENTICATED) {
      const count = routes.filter((r) => r.prefix === prefix).length
      assert.ok(count > 0, `parsed zero routes under ${prefix}`)
    }

    // Spot-check a few known routes, so a regex that silently drops one shape of
    // declaration (options-object, multi-line, bare '/') is caught.
    const urls = new Set(routes.map((r) => `${r.method} ${r.url}`))
    for (const expected of [
      'GET /api/deals',
      `PATCH /api/deals/${PARAM_UUID}`,
      `POST /api/deals/${PARAM_UUID}/events`,
      'GET /api/deals/counterparties/search',
      `POST /api/loyalty/rewards/${PARAM_UUID}/redeem`,
      // Global chat and per-deal threads. Global chat previously had NO backend
      // at all — the browser talked to `global_messages` directly — so these two
      // are pinned here to ensure the replacement can never regress to being
      // unauthenticated.
      'GET /api/messages/global',
      'POST /api/messages/global',
      `GET /api/messages/deals/${PARAM_UUID}/conversation`,
      `POST /api/messages/deals/${PARAM_UUID}/conversation`,
      'GET /api/profiles/me',
      'PUT /api/notifications/preferences',
      'POST /api/admin/vetting/rescreen',
    ]) {
      assert.ok(urls.has(expected), `enumeration is missing ${expected}`)
    }
  })

  test('an unmatched path under a protected prefix 404s — so 401 really does mean "route exists and is gated"', async () => {
    // The probe path must not match ANY declared route. `/api/deals/<one
    // segment>` does not qualify: it matches `app.get('/:id')`, so it 401s
    // (auth runs before the handler's UUID parse) and this assertion fails for
    // a reason that has nothing to do with the property being tested. Three
    // segments deep matches nothing under /api/deals, whose routes are
    // '/', '/:id', '/:id/events' and '/counterparties/search'.
    const res = await app.inject({ method: 'GET', url: '/api/deals/no/such/route' })
    assert.equal(
      res.statusCode,
      404,
      'expected 404 for an unrouted path; if this is 401 then the 401 assertions below prove nothing about route existence',
    )
  })
})

// ── The 401s ────────────────────────────────────────────────────────────────

for (const prefix of MUST_BE_AUTHENTICATED) {
  const routes = authenticatedRoutes().filter((r) => r.prefix === prefix)

  describe(`${prefix} rejects anonymous callers`, () => {
    for (const route of routes) {
      test(`${route.method} ${route.rawPath || '/'}`, async () => {
        for (const variant of BAD_AUTH_HEADERS) {
          const res = await app.inject({
            method: route.method,
            url: route.url,
            headers: variant.headers,
            // A body is sent so the rejection cannot be attributed to an empty
            // payload; auth must fire before any body handling.
            ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: { probe: true } }),
          })

          assertUnauthorizedBody(res, variant.message, `${route.method} ${route.url} [${variant.label}]`)
        }
      })
    }
  })
}

describe('auth rejection is uniform', () => {
  test('a valid-looking token for a non-existent route still 404s rather than 401-ing (no route enumeration signal)', async () => {
    // Both anonymous and bad-token callers should be unable to tell a real
    // protected route from a made-up one *by status alone* only where the route
    // genuinely does not exist; this documents the current, intended behaviour.
    const real = await app.inject({ method: 'GET', url: '/api/loyalty/me' })
    const fake = await app.inject({ method: 'GET', url: '/api/loyalty/definitely-not-a-route' })
    assert.equal(real.statusCode, 401)
    assert.equal(fake.statusCode, 404)
  })

  test('/health stays public', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { status: 'ok' })
  })

  test('the total authenticated surface is what we think it is', () => {
    const total = allRoutes().length
    const authed = authenticatedRoutes().length
    assert.ok(
      authed / total > 0.8,
      `only ${authed}/${total} routes are behind authenticate — a new public surface appeared`,
    )
  })
})
