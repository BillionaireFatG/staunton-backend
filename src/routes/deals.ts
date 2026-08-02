import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import * as dealsService from '../services/deals'
import { COMMODITY_TYPES, DEAL_STATUSES } from '../services/deals'

// Zod at the route boundary, matching applications.ts / onboarding.ts / roles.ts.
// This file previously used `req.body as any` throughout, which let a caller set
// any column on a deal. errorHandler maps ZodError to 400.

const uuidParam = z.object({ id: z.string().uuid('Invalid deal id') })

const createDealSchema = z.object({
  seller_id: z.string().uuid(),
  commodity_type: z.enum(COMMODITY_TYPES),
  quantity: z.coerce.number().positive().finite(),
  unit_price: z.coerce.number().positive().finite(),
  delivery_location: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(5000).optional(),
})

// Deliberately narrow. status and notes are the only party-patchable fields;
// progress_percentage, total_value and reference_number are server-owned.
const updateDealSchema = z
  .object({
    status: z.enum(DEAL_STATUSES).optional(),
    notes: z.string().trim().max(5000).optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.notes !== undefined, {
    message: 'Supply at least one of: status, notes',
  })

const createEventSchema = z.object({
  event_type: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(1000),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  before: z.string().datetime({ offset: true }).optional(),
})

const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Search query must be at least 2 characters').max(100),
})

export async function dealsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.post('/', async (req, reply) => {
    const body = createDealSchema.parse(req.body)
    const deal = await dealsService.createDeal({
      ...body,
      buyer_id: req.userId,
      created_by: req.userId,
    })
    return reply.status(201).send(deal)
  })

  app.get('/', async (req) => {
    const { limit, before } = listQuerySchema.parse(req.query ?? {})
    return dealsService.getDeals(req.userId, { limit, before })
  })

  app.get('/:id', async (req) => {
    const { id } = uuidParam.parse(req.params)
    return dealsService.getDeal(id, req.userId)
  })

  app.patch('/:id', async (req) => {
    const { id } = uuidParam.parse(req.params)
    const patch = updateDealSchema.parse(req.body)
    return dealsService.updateDeal(id, req.userId, patch)
  })

  app.get('/:id/events', async (req) => {
    const { id } = uuidParam.parse(req.params)
    const { limit } = eventsQuerySchema.parse(req.query ?? {})
    return dealsService.getDealEvents(id, req.userId, { limit })
  })

  app.post('/:id/events', async (req, reply) => {
    const { id } = uuidParam.parse(req.params)
    const { event_type, description, metadata } = createEventSchema.parse(req.body)
    const event = await dealsService.createDealEvent(id, req.userId, event_type, description, metadata)
    return reply.status(201).send(event)
  })

  // Same reasoning as GET /api/profiles/search: a bounded page size raises the
  // cost of enumerating the member directory but does not prevent it. Throttled
  // per account, well below the global limit.
  app.get('/counterparties/search', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req) => {
    const { q } = searchQuerySchema.parse(req.query ?? {})
    return dealsService.searchCounterparties(q, req.userId)
  })
}
