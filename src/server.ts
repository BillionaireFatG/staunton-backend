import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'

import { errorHandler } from './middleware/errorHandler'
import { dealsRoutes } from './routes/deals'
import { loyaltyRoutes } from './routes/loyalty'
import { voiceRoutes } from './routes/voice'
import { profilesRoutes } from './routes/profiles'
import { messagesRoutes } from './routes/messages'
import { applicationsRoutes } from './routes/applications'
import { adminVettingRoutes } from './routes/adminVetting'
import { onboardingRoutes } from './routes/onboarding'
import { accessRoutes } from './routes/access'
import { notificationsRoutes } from './routes/notifications'

const app = Fastify({ logger: true })

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(',')

app.register(cors, {
  origin: allowedOrigins,
  credentials: true,
})
app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } })
app.register(websocket)

app.setErrorHandler(errorHandler)

app.register(dealsRoutes, { prefix: '/api/deals' })
app.register(loyaltyRoutes, { prefix: '/api/loyalty' })
app.register(voiceRoutes, { prefix: '/api/voice-rooms' })
app.register(profilesRoutes, { prefix: '/api/profiles' })
app.register(messagesRoutes, { prefix: '/api/messages' })
app.register(applicationsRoutes, { prefix: '/api/applications' })
app.register(adminVettingRoutes, { prefix: '/api/admin/vetting' })
app.register(onboardingRoutes, { prefix: '/api/onboarding' })
app.register(accessRoutes, { prefix: '/api/access' })
app.register(notificationsRoutes, { prefix: '/api/notifications' })

app.get('/health', async () => ({ status: 'ok' }))

const start = async () => {
  try {
    const port = parseInt(process.env.PORT ?? '3001')
    const host = process.env.HOST ?? '0.0.0.0'
    await app.listen({ port, host })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
