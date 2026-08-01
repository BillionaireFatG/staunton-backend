import { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import * as voiceService from '../services/voice'

export async function voiceRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/', async () => {
    return voiceService.getVoiceRooms()
  })

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string }
    return voiceService.getVoiceRoom(id)
  })

  app.get('/:id/participants', async (req) => {
    const { id } = req.params as { id: string }
    return voiceService.getRoomParticipants(id)
  })

  app.post('/:id/join', async (req, reply) => {
    const { id } = req.params as { id: string }
    await voiceService.joinRoom(id, req.userId)
    return reply.status(204).send()
  })

  app.post('/:id/leave', async (req, reply) => {
    const { id } = req.params as { id: string }
    await voiceService.leaveRoom(id, req.userId)
    return reply.status(204).send()
  })

  app.patch('/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string }
    const patch = req.body as { is_muted?: boolean; is_speaking?: boolean }
    await voiceService.updateParticipantStatus(id, req.userId, patch)
    return reply.status(204).send()
  })

  app.get('/:id/messages', async (req) => {
    const { id } = req.params as { id: string }
    const { limit } = req.query as { limit?: string }
    return voiceService.getRoomMessages(id, limit ? parseInt(limit) : 50)
  })

  app.post('/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { content } = req.body as { content: string }
    const msg = await voiceService.sendRoomMessage(id, req.userId, content)
    return reply.status(201).send(msg)
  })
}
