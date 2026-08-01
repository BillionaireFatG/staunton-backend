import { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import * as badges from '../services/badges'
import * as roles from '../services/roles'

// Module 3: badges + roles/permissions. All authenticated (no public badges).
export async function accessRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  // ── Badges ────────────────────────────────────────────────────────────────
  // Own org: granted + missing + how-to-earn.
  app.get('/badges/me', async (req) => badges.getMyBadges(req.userId))
  // Another org (pre-reveal safe): active badges only.
  app.get('/badges/org/:orgId', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return badges.getOrgBadges(orgId)
  })

  // ── Permissions ─────────────────────────────────────────────────────────────
  app.get('/permissions/check', async (req) => {
    const { permission, org_id } = req.query as { permission: string; org_id?: string }
    if (!permission) throw Object.assign(new Error('permission is required'), { statusCode: 400 })
    return { permission, allowed: await roles.hasPermission(req.userId, permission, org_id) }
  })

  // ── Roles ─────────────────────────────────────────────────────────────────
  app.get('/roles', async () => roles.listRoles())
  app.get('/roles/org/:orgId', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return roles.getMemberRoles(orgId)
  })
  app.post('/roles/assign', async (req, reply) => {
    return reply.status(201).send(await roles.assignRole(req.userId, req.body))
  })
  app.post('/roles/:memberRoleId/revoke', async (req, reply) => {
    const { memberRoleId } = req.params as { memberRoleId: string }
    await roles.revokeRole(req.userId, memberRoleId)
    return reply.status(204).send()
  })
}
