import { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import * as loyaltyService from '../services/loyalty'

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

  app.post('/rewards/:rewardId/redeem', async (req, reply) => {
    const { rewardId } = req.params as { rewardId: string }
    await loyaltyService.redeemReward(req.userId, rewardId)
    return reply.status(204).send()
  })

  app.get('/achievements', async (req) => {
    return loyaltyService.getAchievements(req.userId)
  })
}
