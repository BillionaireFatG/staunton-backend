import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth'
import * as loyaltyService from '../services/loyalty'

const redeemParams = z.object({ rewardId: z.string().uuid('rewardId must be a UUID') })

export async function loyaltyRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/me', async (req) => {
    return loyaltyService.getUserLoyalty(req.userId)
  })

  app.get('/transactions', async (req) => {
    return loyaltyService.getLoyaltyTransactions(req.userId)
  })

  app.get('/rewards', async (req) => {
    const loyalty = await loyaltyService.getUserLoyalty(req.userId)
    return loyaltyService.getRewards(loyalty.tier)
  })

  // Returns 200 with the redemption detail (previously a bodyless 204, which
  // gave the client no way to show the new balance without a second request).
  // The reward id is validated as a UUID here so a malformed id is a 400 at the
  // boundary rather than a database error.
  app.post(
    '/rewards/:rewardId/redeem',
    { schema: { params: { type: 'object', required: ['rewardId'], properties: { rewardId: { type: 'string', format: 'uuid' } } } } },
    async (req, reply) => {
      const { rewardId } = redeemParams.parse(req.params)
      const result = await loyaltyService.redeemReward(req.userId, rewardId)
      return reply.status(200).send(result)
    },
  )

  app.get('/achievements', async (req) => {
    return loyaltyService.getAchievements(req.userId)
  })
}
