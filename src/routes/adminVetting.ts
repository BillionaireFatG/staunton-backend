import { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import { requireAdmin } from '../middleware/requireAdmin'
import * as admin from '../services/admin'
import * as onboarding from '../services/onboarding'
import { rescreenActiveOrgs } from '../services/screening'

// Platform-admin only. authenticate sets req.userId, requireAdmin gates on
// profiles.is_admin.
export async function adminVettingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)
  app.addHook('onRequest', requireAdmin)

  // Queue + detail
  app.get('/queue', async (req) => {
    const { status } = req.query as { status?: string }
    return admin.getQueue({ status })
  })

  app.get('/applications/:orgId', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return admin.getApplicationDetail(orgId)
  })

  // Verification checklist (append-only insert)
  app.post('/checks', async (req, reply) => {
    return reply.status(201).send(await admin.insertCheck(req.userId, req.body))
  })

  // Screening review
  app.post('/screenings/review', async (req) => {
    return admin.reviewScreening(req.userId, req.body)
  })

  // Video interview scoresheet
  app.post('/interviews', async (req, reply) => {
    return reply.status(201).send(await admin.saveInterview(req.userId, req.body))
  })

  app.get('/interview-questions', async (req) => {
    const { commodity } = req.query as { commodity?: string }
    return admin.getInterviewQuestions(commodity)
  })

  // Document signed URL
  app.post('/documents/sign', async (req) => {
    const { file_path } = req.body as { file_path: string }
    if (!file_path) throw Object.assign(new Error('file_path is required'), { statusCode: 400 })
    return admin.signedUrl(file_path)
  })

  // Decision panel
  app.post('/applications/:orgId/decision', async (req) => {
    const { orgId } = req.params as { orgId: string }
    const { decision, reason } = req.body as { decision: string; reason?: string }
    return admin.decide(req.userId, orgId, decision, reason)
  })

  // ── Module 2: capacity verification + promotion + re-screening ────────────
  app.post('/capacity/:id/verify', async (req) => {
    const { id } = req.params as { id: string }
    const { outcome, notes } = req.body as { outcome: 'verified' | 'rejected'; notes?: string }
    return onboarding.verifyCapacity(req.userId, id, outcome, notes)
  })

  app.post('/applications/:orgId/promote', async (req) => {
    const { orgId } = req.params as { orgId: string }
    const { override_reason } = (req.body ?? {}) as { override_reason?: string }
    return onboarding.promoteToFull(req.userId, orgId, override_reason)
  })

  // Trigger a re-screen of all active orgs (schedule an external cron to hit this).
  app.post('/rescreen', async () => rescreenActiveOrgs())

  // Invitations
  app.get('/invitations', async () => admin.listInvites())
  app.post('/invitations', async (req, reply) => {
    return reply.status(201).send(await admin.issueInvite(req.userId, req.body))
  })
  app.post('/invitations/:id/revoke', async (req, reply) => {
    const { id } = req.params as { id: string }
    await admin.revokeInvite(id)
    return reply.status(204).send()
  })
}
