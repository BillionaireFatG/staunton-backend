import { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import * as messagesService from '../services/messages'

export async function messagesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/conversations', async (req) => {
    return messagesService.getConversations(req.userId)
  })

  app.post('/conversations', async (req, reply) => {
    const { recipient_id } = req.body as { recipient_id: string }
    const conversation = await messagesService.getOrCreateConversation(req.userId, recipient_id)
    return reply.status(201).send(conversation)
  })

  app.get('/conversations/:id', async (req) => {
    const { id } = req.params as { id: string }
    const { limit, before } = req.query as { limit?: string; before?: string }
    return messagesService.getMessages(id, req.userId, limit ? parseInt(limit) : 50, before)
  })

  app.post('/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { content } = req.body as { content: string }
    const msg = await messagesService.sendMessage(id, req.userId, content)
    return reply.status(201).send(msg)
  })

  app.post('/conversations/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string }
    await messagesService.markAsRead(id, req.userId)
    return reply.status(204).send()
  })

  app.get('/unread-count', async (req) => {
    const count = await messagesService.getTotalUnreadCount(req.userId)
    return { count }
  })
}
