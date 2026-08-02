import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import * as voiceService from '../services/voice'

const roomParams = z.object({ id: z.string().uuid('room id must be a UUID') })
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
// `.strict()`, matching deals.ts / profiles.ts / notifications.ts. Without it
// Zod silently STRIPS unknown keys, so `{is_muted:true, user_id:"<victim>"}`
// returned 204 as though the whole body had been accepted. The service
// re-whitelists, so nothing was ever written — but a caller could not tell a
// rejected field from an applied one, and that is exactly the ambiguity that
// hides the next mass-assignment bug.
const statusBody = z
  .object({
    is_muted: z.boolean().optional(),
    is_speaking: z.boolean().optional(),
  })
  .strict()
const messageBody = z.object({ content: z.string().trim().min(1).max(4000) }).strict()

// Every route requires a Supabase JWT. Being authenticated is NOT by itself
// authorization to touch a given room — the per-room access check lives in
// services/voice.ts and is applied on every call.
export async function voiceRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/', async (req) => {
    return voiceService.getVoiceRooms(req.userId)
  })

  app.get('/:id', async (req) => {
    const { id } = roomParams.parse(req.params)
    return voiceService.getVoiceRoom(id, req.userId)
  })

  app.get('/:id/participants', async (req) => {
    const { id } = roomParams.parse(req.params)
    return voiceService.getRoomParticipants(id, req.userId)
  })

  app.post('/:id/join', async (req, reply) => {
    const { id } = roomParams.parse(req.params)
    await voiceService.joinRoom(id, req.userId)
    return reply.status(204).send()
  })

  app.post('/:id/leave', async (req, reply) => {
    const { id } = roomParams.parse(req.params)
    await voiceService.leaveRoom(id, req.userId)
    return reply.status(204).send()
  })

  app.patch('/:id/status', async (req, reply) => {
    const { id } = roomParams.parse(req.params)
    // Parsed, not cast. The service whitelists again; both layers matter.
    const patch = statusBody.parse(req.body ?? {})
    await voiceService.updateParticipantStatus(id, req.userId, patch)
    return reply.status(204).send()
  })

  app.get('/:id/messages', async (req) => {
    const { id } = roomParams.parse(req.params)
    const { limit } = listQuery.parse(req.query ?? {})
    return voiceService.getRoomMessages(id, req.userId, limit)
  })

  app.post('/:id/messages', async (req, reply) => {
    const { id } = roomParams.parse(req.params)
    const { content } = messageBody.parse(req.body ?? {})
    const msg = await voiceService.sendRoomMessage(id, req.userId, content)
    return reply.status(201).send(msg)
  })
}
