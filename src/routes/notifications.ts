import { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import * as notificationsService from '../services/notifications'

export async function notificationsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/preferences', async (req) => {
    return notificationsService.getPreferences(req.userId)
  })

  app.put('/preferences', async (req) => {
    return notificationsService.updatePreferences(req.userId, req.body as any)
  })
}
