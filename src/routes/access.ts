import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import * as badges from '../services/badges'
import * as roles from '../services/roles'

const orgParams = z.object({ orgId: z.string().uuid('orgId must be a UUID') })
const checkQuery = z.object({ permission: z.string().min(1, 'permission is required') })
const revokeParams = z.object({ memberRoleId: z.string().uuid('memberRoleId must be a UUID') })

// Module 3: badges + roles/permissions. All authenticated (no public badges).
export async function accessRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  // ── Badges ────────────────────────────────────────────────────────────────
  // Own org: granted + missing + how-to-earn.
  app.get('/badges/me', async (req) => badges.getMyBadges(req.userId))
  // Another org (pre-reveal safe): active badges only.
  app.get('/badges/org/:orgId', async (req) => {
    const { orgId } = orgParams.parse(req.params)
    return badges.getOrgBadges(orgId)
  })

  // ── Permissions ─────────────────────────────────────────────────────────────
  // `org_id` is deliberately NOT accepted from the client. has_permission()
  // resolves the org as coalesce(p_org, caller's own org) and then gates on THAT
  // org's status, so passing another org's id returned an answer computed
  // against a stranger's status — e.g. `true` for deal.enter while the caller's
  // own org is still provisional. The caller's org is resolved server-side.
  app.get('/permissions/check', async (req) => {
    const { permission } = checkQuery.parse(req.query)
    return { permission, allowed: await roles.hasPermission(req.userId, permission) }
  })

  // ── Roles ─────────────────────────────────────────────────────────────────
  app.get('/roles', async () => roles.listRoles())
  app.get('/roles/org/:orgId', async (req) => {
    const { orgId } = orgParams.parse(req.params)
    return roles.getMemberRoles(req.userId, orgId)
  })
  app.post('/roles/assign', async (req, reply) => {
    return reply.status(201).send(await roles.assignRole(req.userId, req.body))
  })
  app.post('/roles/:memberRoleId/revoke', async (req, reply) => {
    const { memberRoleId } = revokeParams.parse(req.params)
    await roles.revokeRole(req.userId, memberRoleId)
    return reply.status(204).send()
  })
}
