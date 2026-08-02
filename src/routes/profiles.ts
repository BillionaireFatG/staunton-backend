import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import * as profilesService from '../services/profiles'

const idParams = z.object({ id: z.string().uuid('profile id must be a UUID') })
const searchQuery = z.object({
  q: z.string().trim().min(2, 'Search query must be at least 2 characters'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

// Whitelist for PATCH /me. Only these fields may be set through the profile
// patch: the service-role client bypasses RLS, so anything accepted here is
// written. `.strict()` rejects unknown keys outright rather than silently
// dropping them, so a client sending `is_admin` or `verification_status` gets a
// 400 instead of a false sense that it worked.
const patchBody = z
  .object({
    full_name: z.string().trim().min(1).optional(),
    bio: z.string().max(2000).nullable().optional(),
    avatar_url: z.string().url().nullable().optional(),
    company_name: z.string().trim().max(200).nullable().optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    location: z.string().trim().max(200).nullable().optional(),
  })
  .strict()

export async function profilesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/me', async (req) => {
    return profilesService.getProfile(req.userId)
  })

  app.patch('/me', async (req) => {
    // Parsed against a strict schema, not cast. `req.body as any` asserted
    // nothing at runtime; the service's whitelist was doing all the work alone.
    return profilesService.upsertProfile(req.userId, patchBody.parse(req.body ?? {}))
  })

  // `limit` is bounded at the route AND clamped again in the service. It was
  // previously `parseInt(limit)` straight into `.limit()` — `?limit=100000`
  // with an empty `q` dumped the whole member directory.
  app.get('/search', async (req) => {
    const { q, limit } = searchQuery.parse(req.query ?? {})
    return profilesService.searchProfiles(q, limit)
  })

  app.get('/:id', async (req) => {
    const { id } = idParams.parse(req.params)
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
