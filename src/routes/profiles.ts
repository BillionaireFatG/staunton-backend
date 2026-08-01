import { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import * as profilesService from '../services/profiles'

export async function profilesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/me', async (req) => {
    return profilesService.getProfile(req.userId)
  })

  app.patch('/me', async (req) => {
    return profilesService.upsertProfile(req.userId, req.body as any)
  })

  app.get('/search', async (req) => {
    const { q, limit } = req.query as { q: string; limit?: string }
    return profilesService.searchProfiles(q ?? '', limit ? parseInt(limit) : 20)
  })

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string }
    return profilesService.getPublicProfile(id)
  })

  // Avatar upload — multipart, single file field named `file`.
  app.post('/me/avatar', async (req, reply) => {
    const data = await req.file()
    if (!data) throw Object.assign(new Error('No file uploaded'), { statusCode: 400 })
    const buffer = await data.toBuffer()
    const profile = await profilesService.uploadAvatar(req.userId, {
      buffer,
      filename: data.filename,
      mimetype: data.mimetype,
    })
    return reply.status(200).send(profile)
  })

  // Avatar remove — clears profiles.avatar_url and best-effort deletes the object.
  app.delete('/me/avatar', async (req) => {
    return profilesService.removeAvatar(req.userId)
  })

  // Verification request — multipart with zero-or-more file parts (field
  // `documents`). Uploads docs to storage and records the pending request.
  app.post('/me/verify', async (req, reply) => {
    const files: Array<{ buffer: Buffer; filename: string; mimetype: string }> = []
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          files.push({
            buffer: await part.toBuffer(),
            filename: part.filename,
            mimetype: part.mimetype,
          })
        }
      }
    }
    const profile = await profilesService.requestVerification(req.userId, files)
    return reply.status(200).send(profile)
  })
}
