import { FastifyInstance } from 'fastify'
import * as applications from '../services/applications'

// PUBLIC routes — no authenticate hook. A stranger with no account applies here.
// All persistence is via the service-role client inside the service layer.
export async function applicationsRoutes(app: FastifyInstance) {
  app.post('/validate-invite', async (req) => {
    const { code } = (req.body ?? {}) as { code?: string }
    if (!code) return { valid: false, reason: 'not_found' }
    return applications.validateInvite(code)
  })

  app.post('/', async (req, reply) => {
    const result = await applications.startApplication(req.body)
    return reply.status(201).send(result)
  })

  app.get('/:orgId', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return applications.getApplication(orgId)
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

  // Multipart document upload
  app.post('/:orgId/documents', async (req, reply) => {
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

  app.post('/:orgId/submit', async (req, reply) => {
    const { orgId } = req.params as { orgId: string }
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip
    const result = await applications.submitApplication(orgId, req.body, ip)
    return reply.status(200).send(result)
  })
}
