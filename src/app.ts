import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'

import { errorHandler } from './middleware/errorHandler'
import { dealsRoutes } from './routes/deals'
import { loyaltyRoutes } from './routes/loyalty'
import { voiceRoutes } from './routes/voice'
import { profilesRoutes } from './routes/profiles'
import { messagesRoutes } from './routes/messages'
import { applicationsRoutes } from './routes/applications'
import { adminVettingRoutes } from './routes/adminVetting'
import { onboardingRoutes } from './routes/onboarding'
import { accessRoutes } from './routes/access'
import { notificationsRoutes } from './routes/notifications'

/**
 * Proxy trust.
 *
 * Rate limiting and the submitted-application audit trail both key off the
 * client IP, and behind a load balancer `req.ip` is the proxy unless Fastify is
 * told otherwise. This is opt-in via env rather than on by default, because
 * blindly trusting `X-Forwarded-For` when NOT behind a proxy lets any caller
 * spoof the header, rotate their rate-limit key at will, and forge the IP
 * recorded on an attestation.
 *
 * Set TRUST_PROXY only when something in front of this server actually
 * overwrites X-Forwarded-For: `true`, a hop count, or a CIDR / comma-separated
 * IP list (all accepted by Fastify).
 */
function trustProxySetting(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim()
  if (!raw) return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^\d+$/.test(raw)) return Number(raw)
  return raw
}

export interface BuildAppOptions {
  logger?: boolean
  /**
   * Disable rate limiting. For test runs only — a harness that exercises an
   * endpoint 50 times to prove an authorization property should not trip the
   * throttle it is not testing. Never set this in a served process.
   */
  disableRateLimit?: boolean
}

/**
 * Build the Fastify instance without listening.
 *
 * Split out from `server.ts` so tests can drive real routes through
 * `app.inject()` — hooks, error handler, serialization and all. Authorization
 * lives partly in route hooks (see routes/applications.ts), and a service-level
 * test cannot see those, so anything asserting "this endpoint rejects an
 * unauthorized caller" has to go through the built app.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: trustProxySetting(),
  })

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(',')

  app.register(cors, { origin: allowedOrigins, credentials: true })
  app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } })

  /**
   * Rate limiting — two layers, because one cannot do both jobs.
   *
   * @fastify/rate-limit attaches its check as a ROUTE-level hook (via onRoute),
   * and route-level hooks run AFTER the plugin-scoped `onRequest` hooks that
   * every route file uses for `authenticate`. Verified, not assumed. Two
   * consequences fall out of that ordering:
   *
   *  1. `req.userId` IS populated by the time the limiter's keyGenerator runs,
   *     so the main limit can be keyed per account rather than per IP. That
   *     matters here: a trading firm's staff share one office egress IP, and an
   *     IP-keyed bucket makes one busy dashboard throttle a colleague. Keying on
   *     the account also stops a single logged-in user shedding their limit by
   *     rotating through a proxy pool.
   *
   *  2. `authenticate` — which costs a network round trip to Supabase
   *     `getUser` — has ALREADY run by then. A limiter that only fires after
   *     that call can never protect it: someone spraying garbage bearer tokens
   *     gets a Supabase auth request per attempt and is billed 429 afterwards.
   *
   * So: LAYER 1 is a root `onRequest` gate, IP-keyed, deliberately generous,
   * whose only job is to run before `authenticate` and cap that amplifier.
   * LAYER 2 is the plugin's own global limit, account-keyed, and the one that
   * per-route `config.rateLimit` overrides tighten.
   *
   * Layer 1 must stay IP-keyed. At that point the only caller-supplied identity
   * is the bearer token, which is attacker-chosen — keying on it would let one
   * client mint unlimited buckets by varying a token it never has to make valid.
   *
   * Two consequences of that same ordering, both verified, both intended:
   *
   *  - A request that fails `authenticate` never reaches the route-level
   *    limiter, so layer 2 counts only AUTHENTICATED traffic. Unauthenticated
   *    spray at an authenticated route is layer 1's job, which is why layer 1
   *    exists at all. The tight per-route limits on the search endpoints are
   *    therefore limits on what a logged-in member may scrape — which is the
   *    actual threat there — not on anonymous traffic.
   *
   *  - `/health` below is registered on the root instance BEFORE this plugin
   *    finishes loading, so the plugin's `onRoute` hook never sees it and layer
   *    2 does not apply to it; only layer 1 does. Fine for a health check, but
   *    it means "register it globally and future routes inherit protection"
   *    holds for routes inside plugins registered after this point — which is
   *    all of them — and not for routes added directly to the root above it.
   *
   * In-memory store: both limits are per process, so neither holds across a
   * multi-instance deployment. That is a real gap — it wants a Redis store
   * before this runs on more than one node — but a per-process limit still
   * turns an unthrottled brute force into a slow one.
   */
  const rateLimitEnabled = !options.disableRateLimit

  // Shared 429 body, so clients parse one error format across both layers and
  // the global error handler.
  const tooManyRequests = (after: string) => ({
    statusCode: 429,
    error: 'TooManyRequests',
    message: `Rate limit exceeded. Retry in ${after}.`,
    code: 'rate_limited',
  })

  app.register(rateLimit, {
    global: rateLimitEnabled,
    max: 300,
    timeWindow: '1 minute',
    // Per account when we know it, per IP otherwise (the unauthenticated
    // application funnel). Namespaced so an account id can never collide with
    // an IP-shaped key.
    keyGenerator: (req) => (req.userId ? `user:${req.userId}` : `ip:${req.ip}`),
    errorResponseBuilder: (_req, context) => tooManyRequests(context.after),
  })

  if (rateLimitEnabled) {
    // `createRateLimit` is a decorator, so it only exists once the plugin above
    // has loaded — hence `after()`. Registering the hook here also keeps it
    // ahead of the route plugins below, which is what puts it before
    // `authenticate`.
    app.after(() => {
      const preAuthGate = app.createRateLimit({
        max: 600,
        timeWindow: '1 minute',
        keyGenerator: (req) => `preauth:${req.ip}`,
      })

      app.addHook('onRequest', async (req, reply) => {
        const result = await preAuthGate(req)
        // API sharp edge: `isAllowed: true` is returned ONLY when the caller
        // matched an allowList — it does NOT mean "under the limit". Every
        // counted request comes back `isAllowed: false` with the detail, and
        // the actual over-limit signal is `isExceeded`. Reading `isAllowed` as
        // "ok" 429s the very first request.
        if (result.isAllowed || !result.isExceeded) return
        reply
          .header('retry-after', String(result.ttlInSeconds))
          .status(429)
          .send(tooManyRequests(`${result.ttlInSeconds} seconds`))
      })
    })
  }

  app.setErrorHandler(errorHandler)

  app.register(dealsRoutes, { prefix: '/api/deals' })
  app.register(loyaltyRoutes, { prefix: '/api/loyalty' })
  app.register(voiceRoutes, { prefix: '/api/voice-rooms' })
  app.register(profilesRoutes, { prefix: '/api/profiles' })
  app.register(messagesRoutes, { prefix: '/api/messages' })
  app.register(applicationsRoutes, { prefix: '/api/applications' })
  app.register(adminVettingRoutes, { prefix: '/api/admin/vetting' })
  app.register(onboardingRoutes, { prefix: '/api/onboarding' })
  app.register(accessRoutes, { prefix: '/api/access' })
  app.register(notificationsRoutes, { prefix: '/api/notifications' })

  app.get('/health', async () => ({ status: 'ok' }))

  return app
}
