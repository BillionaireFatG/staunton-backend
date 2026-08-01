import { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import * as onboarding from '../services/onboarding'

// Authenticated org-member onboarding wizard (provisional org completing setup).
export async function onboardingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/state', async (req) => onboarding.getState(req.userId))

  app.post('/terms', async (req) => onboarding.acceptTerms(req.userId))

  app.put('/profile', async (req) => onboarding.saveProfile(req.userId, req.body))

  app.post('/members', async (req, reply) =>
    reply.status(201).send(await onboarding.inviteMember(req.userId, req.body)),
  )

  app.post('/capacity', async (req, reply) =>
    reply.status(201).send(await onboarding.submitCapacity(req.userId, req.body)),
  )

  app.post('/complete', async (req) => onboarding.completeOnboarding(req.userId))
}
