import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import * as messagesService from '../services/messages'

const idParams = z.object({ id: z.string().uuid('conversation id must be a UUID') })
const startBody = z.object({ recipient_id: z.string().uuid('recipient_id must be a UUID') })
const messageBody = z.object({ content: z.string().trim().min(1).max(10000) })
const historyQuery = z.object({
  // Client-controlled page size, bounded server-side. Unbounded, it is a bulk
  // export lever on any conversation the caller belongs to.
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
})

export async function messagesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/conversations', async (req) => {
    return messagesService.getConversations(req.userId)
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
