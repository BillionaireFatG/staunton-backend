import 'dotenv/config'
import { buildApp } from './app'

// Entry point. Route registration and plugin wiring live in `app.ts` so that
// tests can build the same instance and drive it with `inject()` without
// binding a port.
const app = buildApp()

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
