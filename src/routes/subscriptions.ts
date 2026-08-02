import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import * as subscriptions from '../services/subscriptions'

// `org_id` is deliberately absent from every schema here.
//
// The service resolves the caller's org from their member row instead. Both
// underlying RPCs are SECURITY DEFINER taking an org id on trust, so a route
// that accepted one would let any member read — or change — another firm's
// subscription. This is the same rule access.ts applies to has_permission, and
// it is there because passing another org's id previously returned an answer
// computed against a stranger's status.

const planBody = z
  .object({
    plan_key: z.string().min(1).max(64),
    // Only the two statuses a human action can legitimately produce. Everything
    // else ('past_due', 'expired') belongs to a billing process that does not
    // exist yet, and must not be settable from a request — a client that could
    // POST status:'active' against an unpaid account would be granting itself
    // entitlements. Enumerated rather than free text so the surface stays this
    // small when a payment provider is added.
    status: z.enum(['active', 'trialing']).default('active'),
    reason: z.string().trim().max(500).optional(),
  })
  .strict()

const cancelBody = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict()

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/**
 * Subscription foundation. No payment provider is wired up, so nothing here
 * charges anyone; POST /me exists so the state machine is exercisable and so
 * adding a provider later is an integration rather than a redesign.
 *
 * Expect POST /me to return 409 `plan_inactive` for every seeded paid plan.
 * That is the designed behaviour, not a defect: no plan is sellable until real
 * pricing is set, and the database constraint enforces that an active plan has
 * a real, non-placeholder price.
 */
export async function subscriptionsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  // Catalogue. Ordinary members see sellable plans; org/platform admins also see
  // unreleased ones, since they are the only people who can act on them.
  app.get('/plans', async (req) => subscriptions.listPlans(req.userId))

  // The caller's own firm: plan, status and resolved entitlements.
  app.get('/me', async (req) => subscriptions.getMySubscription(req.userId))

  // Entitlements alone — the common case for a client deciding what to render.
  // Fails closed: no subscription yields the base floor, never full access.
  app.get('/entitlements', async (req) => ({
    entitlements: await subscriptions.getEntitlements(req.userId),
  }))

  // Commercial history. Admin-only, enforced in the service.
  app.get('/me/events', async (req) => {
    const { limit } = historyQuery.parse(req.query ?? {})
    return subscriptions.getSubscriptionHistory(req.userId, limit)
  })

  // Org admin or platform admin only. Atomic in the database.
  app.post('/me', async (req) => {
    const { plan_key, status, reason } = planBody.parse(req.body ?? {})
    return subscriptions.setPlan(req.userId, plan_key, status, reason)
  })

  app.post('/me/cancel', async (req) => {
    const { reason } = cancelBody.parse(req.body ?? {})
    return subscriptions.cancel(req.userId, reason)
  })
}
