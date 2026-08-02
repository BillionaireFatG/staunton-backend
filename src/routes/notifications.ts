import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import * as notificationsService from '../services/notifications'

// Zod at the route boundary, matching deals.ts / profiles.ts / applications.ts.
// This was the last `req.body as any` in the codebase. The service already
// whitelists fields, but the cast meant the route asserted nothing at runtime
// and nothing at compile time either — the whitelist was load-bearing and
// invisible. `.strict()` also turns a client sending `user_id` (an attempt to
// write another member's preferences) into a 400 rather than a silent no-op.
//
// Quiet hours are stored on the hour only; the service enforces the same
// pattern, and both are kept deliberately.
const quietHour = z
  .string()
  .regex(/^([01]\d|2[0-3]):00$/, 'must match HH:00 (00:00–23:00)')

const preferencesBody = z
  .object({
    // Email
    deal_updates: z.boolean().optional(),
    new_messages: z.boolean().optional(),
    price_alerts: z.boolean().optional(),
    weekly_digest: z.boolean().optional(),
    marketing: z.boolean().optional(),
    // Push
    desktop: z.boolean().optional(),
    sound: z.boolean().optional(),
    do_not_disturb: z.boolean().optional(),
    // Quiet hours
    quiet_hours_enabled: z.boolean().optional(),
    quiet_hours_start: quietHour.optional(),
    quiet_hours_end: quietHour.optional(),
  })
  .strict()

export async function notificationsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/preferences', async (req) => {
    return notificationsService.getPreferences(req.userId)
  })

  // An empty body is allowed and is a no-op that guarantees the defaults row
  // exists — same effect as GET. Rejecting it would break nothing but would
  // also protect nothing.
  app.put('/preferences', async (req) => {
    const patch = preferencesBody.parse(req.body ?? {})
    return notificationsService.updatePreferences(req.userId, patch)
  })
}
