import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import * as messagesService from '../services/messages'

const idParams = z.object({ id: z.string().uuid('conversation id must be a UUID') })
const dealParams = z.object({ dealId: z.string().uuid('dealId must be a UUID') })
const startBody = z.object({ recipient_id: z.string().uuid('recipient_id must be a UUID') }).strict()
const messageBody = z.object({ content: z.string().trim().min(1).max(10000) }).strict()
// Global chat is a broadcast to every member, so it is held to a tighter length
// than a private thread — same bound as voice room chat.
const globalBody = z.object({ content: z.string().trim().min(1).max(4000) }).strict()

/**
 * Client-controlled page size, bounded server-side. Unbounded, it is a bulk
 * export lever. `before` is a keyset cursor on created_at, not an offset:
 * stable under concurrent inserts and no deep-offset scan.
 */
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
})

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export async function messagesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  // ── Global chat ───────────────────────────────────────────────────────────
  // Declared BEFORE the /conversations/:id routes purely for readability; these
  // are distinct literal paths so ordering does not affect matching.
  //
  // This is the supported replacement for the browser talking to
  // `global_messages` directly, which violated the three-layer rule and relied
  // on an RLS policy that was readable by the anon key (finding F-8).
  app.get('/global', async (req) => {
    const { limit, before } = historyQuery.parse(req.query ?? {})
    return messagesService.getGlobalMessages(limit, before)
  })

  app.post('/global', async (req, reply) => {
    const { content } = globalBody.parse(req.body ?? {})
    // sender is req.userId, from the validated JWT — never from the body.
    const msg = await messagesService.sendGlobalMessage(req.userId, content)
    return reply.status(201).send(msg)
  })

  // ── Per-deal threads ──────────────────────────────────────────────────────
  // Authorized against the deal, not the conversation: the service reuses
  // deals.getDeal(), which is the single home of the buyer/seller/broker
  // predicate and 404s for a non-party.
  //
  // GET and POST are the same find-or-create operation. GET is offered because
  // opening a deal thread is a read from the client's point of view, and POST
  // because it may create a row; both are idempotent and return the same body.
  app.get('/deals/:dealId/conversation', async (req) => {
    const { dealId } = dealParams.parse(req.params)
    return messagesService.getOrCreateDealConversation(dealId, req.userId)
  })

  app.post('/deals/:dealId/conversation', async (req, reply) => {
    const { dealId } = dealParams.parse(req.params)
    const conversation = await messagesService.getOrCreateDealConversation(dealId, req.userId)
    return reply.status(201).send(conversation)
  })

  // ── Direct conversations ──────────────────────────────────────────────────
  app.get('/conversations', async (req) => {
    const { limit } = listQuery.parse(req.query ?? {})
    return messagesService.getConversations(req.userId, limit)
  })

  app.post('/conversations', async (req, reply) => {
    const { recipient_id } = startBody.parse(req.body ?? {})
    const conversation = await messagesService.getOrCreateConversation(req.userId, recipient_id)
    return reply.status(201).send(conversation)
  })

  app.get('/conversations/:id', async (req) => {
    const { id } = idParams.parse(req.params)
    const { limit, before } = historyQuery.parse(req.query ?? {})
    return messagesService.getMessages(id, req.userId, limit, before)
  })

  app.post('/conversations/:id/messages', async (req, reply) => {
    const { id } = idParams.parse(req.params)
    const { content } = messageBody.parse(req.body ?? {})
    const msg = await messagesService.sendMessage(id, req.userId, content)
    return reply.status(201).send(msg)
  })

  app.post('/conversations/:id/read', async (req, reply) => {
    const { id } = idParams.parse(req.params)
    await messagesService.markAsRead(id, req.userId)
    return reply.status(204).send()
  })

  app.get('/unread-count', async (req) => {
    const count = await messagesService.getTotalUnreadCount(req.userId)
    return { count }
  })
}
