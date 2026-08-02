import { FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import { ZodError } from 'zod'

const STATUS_NAMES: Record<number, string> = {
  400: 'BadRequest',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  409: 'Conflict',
  413: 'PayloadTooLarge',
  415: 'UnsupportedMediaType',
  422: 'UnprocessableEntity',
  429: 'TooManyRequests',
  500: 'InternalServerError',
  503: 'ServiceUnavailable',
}

/**
 * Global error handler.
 *
 * Two rules:
 *   1. A ZodError is a client input problem, not a server fault — it maps to 400
 *      with per-field detail. Previously it fell through as a 500.
 *   2. Anything 5xx returns a GENERIC message. Service-layer code does
 *      `throw new Error(error.message)` with raw Supabase/Postgres text, which
 *      otherwise reaches the client and discloses table names, column names and
 *      constraint definitions. The full error is still logged server-side.
 */
export function errorHandler(error: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ZodError) {
    req.log.warn({ err: error, url: req.url }, 'request failed validation')
    return reply.status(400).send({
      statusCode: 400,
      error: 'BadRequest',
      message: 'Request validation failed',
      details: error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    })
  }

  // Fastify's own body-parser / schema errors already carry a 4xx statusCode.
  const statusCode = error.statusCode ?? 500

  if (statusCode >= 500) {
    req.log.error({ err: error, url: req.url }, 'unhandled error')
    return reply.status(statusCode).send({
      statusCode,
      error: STATUS_NAMES[statusCode] ?? 'InternalServerError',
      message:
        statusCode === 503
          ? error.message // 503s here are deliberate, operator-facing and safe
          : 'An unexpected error occurred',
    })
  }

  req.log.info({ err: error, url: req.url }, 'request rejected')
  return reply.status(statusCode).send({
    statusCode,
    error: STATUS_NAMES[statusCode] ?? error.name ?? 'Error',
    message: error.message ?? 'Request could not be processed',
  })
}
