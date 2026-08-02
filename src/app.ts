import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
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
  app.register(websocket)

  /**
   * Rate limiting.
   *
   * Registered globally with a generous per-IP ceiling so that nothing is
   * unprotected by omission; the routes that actually need to be strict tighten
   * it per-route via `config.rateLimit` (see routes/applications.ts, which is
   * the unauthenticated funnel and therefore the exposed surface).
   *
   * In-memory store: the limit is per process, so it does not hold across a
   * multi-instance deployment. That is a real gap — it wants a Redis store
   * before this runs on more than one node — but a per-process limit still
   * turns an unthrottled brute force into a slow one.
   */
  app.register(rateLimit, {
    global: !options.disableRateLimit,
    max: 300,
    timeWindow: '1 minute',
    // Match the global error handler's shape so clients parse one error format.
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'TooManyRequests',
      message: `Rate limit exceeded. Retry in ${context.after}.`,
      code: 'rate_limited',
    }),
  })

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
