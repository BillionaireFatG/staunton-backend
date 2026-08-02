import { FastifyInstance } from 'fastify'
import * as applications from '../services/applications'
import { DRAFT_TOKEN_HEADER, verifyDraftToken } from '../lib/draftToken'

// PUBLIC routes — no authenticate hook. A stranger with no account applies here,
// so there is no Supabase JWT to check. All persistence is via the service-role
// client inside the service layer.
//
// AUTHORIZATION: everything under /:orgId is gated on the signed draft token
// issued by POST /api/applications. Before this, an org UUID was the only thing
// those routes required — an identifier, not a secret, treated as proof of
// ownership. See lib/draftToken.ts.
export async function applicationsRoutes(app: FastifyInstance) {
  // Deliberately keyed on the PRESENCE of an :orgId param rather than an
  // explicit per-route list. A route added to this file later is protected by
  // default; forgetting to opt in is not a possible mistake. The two entry
  // points that legitimately predate a token (validate-invite, and the POST
  // that mints one) have no :orgId and so are skipped.
  //
  // preHandler, not onRequest: params are guaranteed populated by then, and it
  // still runs before the handler touches the multipart stream.
  app.addHook('preHandler', async (req) => {
    const orgId = (req.params as { orgId?: string } | undefined)?.orgId
    if (!orgId) return
    verifyDraftToken(req.headers[DRAFT_TOKEN_HEADER], orgId)
  })

  // Invite-code check. The strictest limit on the platform: this is an
  // unauthenticated oracle that answers "is this code real?", so without a limit
  // it is a brute-force target, and an invite is a free pass past the public
  // queue. 10 attempts per 10 minutes per IP — generous for a human typing a
  // code from an email, useless for enumeration.
  app.post(
    '/validate-invite',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req) => {
      const { code } = (req.body ?? {}) as { code?: string }
      if (!code) return { valid: false, reason: 'not_found' }
      return applications.validateInvite(code)
    },
  )

  // Starting an application writes an organizations row and a members row, so
  // an unthrottled caller can flood the vetting queue with junk firms.
  app.post(
    '/',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const result = await applications.startApplication(req.body)
      return reply.status(201).send(result)
    },
  )

  app.get('/:orgId', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return applications.getApplication(orgId)
  })

  // Status-only, available after submission (getApplication is draft-only).
  app.get('/:orgId/status', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return applications.getApplicationStatus(orgId)
  })

  app.patch('/:orgId/company', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return applications.saveCompany(orgId, req.body)
  })

  app.patch('/:orgId/trading', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return applications.saveTrading(orgId, req.body)
  })

  app.patch('/:orgId/principal', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return applications.savePrincipal(orgId, req.body)
  })

  app.patch('/:orgId/history', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return applications.saveHistory(orgId, req.body)
  })

  app.post('/:orgId/owners', async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    return reply.status(201).send(await applications.addOwner(orgId, req.body))
  })

  app.delete('/:orgId/owners/:ownerId', async (req, reply) => {
    const { orgId, ownerId } = req.params as { orgId: string; ownerId: string }
    await applications.removeOwner(orgId, ownerId)
    return reply.status(204).send()
  })

  app.post('/:orgId/members', async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    return reply.status(201).send(await applications.addMember(orgId, req.body))
  })

  // Multipart document upload. Tight limit: each call costs a 20MB write to
  // Supabase storage that nothing reclaims, so an unthrottled uploader is a
  // direct bill and a storage-exhaustion lever, not just noise.
  app.post('/:orgId/documents', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    const data = await req.file()
    if (!data) throw Object.assign(new Error('No file uploaded'), { statusCode: 400 })

    const docType = (data.fields?.doc_type as any)?.value as string | undefined
    const buffer = await data.toBuffer()

    const doc = await applications.uploadDocument(orgId, {
      docType: docType ?? '',
      filename: data.filename,
      mimeType: data.mimetype,
      buffer,
    })
    return reply.status(201).send(doc)
  })

  app.post('/:orgId/submit', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    // req.ip already honours X-Forwarded-For when TRUST_PROXY is configured
    // (see server.ts). Reading the header directly regardless of proxy trust
    // let any caller forge the IP recorded on the attestation — the one field
    // in the submission that exists to be evidence.
    const ip = req.ip
    const result = await applications.submitApplication(orgId, req.body, ip)
    return reply.status(200).send(result)
  })
}
