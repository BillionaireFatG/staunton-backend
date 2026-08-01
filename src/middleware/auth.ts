import { FastifyRequest, FastifyReply } from 'fastify'
import { supabase } from '../lib/supabase'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Missing bearer token' })
  }

  const token = authHeader.slice(7)
  const { data, error } = await supabase.auth.getUser(token)

  if (error || !data.user) {
    return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' })
  }

  req.userId = data.user.id
}
