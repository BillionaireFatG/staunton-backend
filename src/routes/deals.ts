import { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import * as dealsService from '../services/deals'

export async function dealsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.post('/', async (req, reply) => {
    const body = req.body as any
    const deal = await dealsService.createDeal({ ...body, buyer_id: req.userId })
    return reply.status(201).send(deal)
  })

  app.get('/', async (req) => {
    return dealsService.getDeals(req.userId)
  })

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string }
    return dealsService.getDeal(id, req.userId)
  })

  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string }
    return dealsService.updateDeal(id, req.userId, req.body as any)
  })

  app.get('/:id/events', async (req) => {
    const { id } = req.params as { id: string }
    return dealsService.getDealEvents(id, req.userId)
  })

  app.post('/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { type, payload } = req.body as { type: string; payload: Record<string, unknown> }
    const event = await dealsService.createDealEvent(id, req.userId, type, payload)
    return reply.status(201).send(event)
  })

  app.get('/counterparties/search', async (req) => {
    const { q } = req.query as { q: string }
    return dealsService.searchCounterparties(q ?? '', req.userId)
  })
}
