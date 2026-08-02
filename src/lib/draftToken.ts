// ============================================================================
// draftToken.ts — signed, expiring capability token for the public application
// funnel.
// ============================================================================
//
// The application funnel is deliberately unauthenticated: a stranger with no
// account fills it in, so there is no Supabase JWT to check. Before this, the
// only thing standing between an attacker and another firm's application was
// knowing an org UUID, which every `/api/applications/:orgId/*` route accepted
// as proof of ownership. It is an identifier, not a secret, and it is handed to
// the client, logged, and embedded in URLs.
//
// `POST /api/applications` now mints a token bound to the org it just created.
// Holding it is the proof of ownership those routes were missing.
//
// WHY NODE CRYPTO AND NOT @fastify/jwt
// `@fastify/jwt` is a dependency of this project and was unused. It is still
// unused, on purpose. This is a bearer capability with exactly one issuer, one
// audience and one claim; a raw HMAC keeps it verifiable as a plain function,
// which means the service layer and the test harness can check it without
// standing up a Fastify instance and without a decorator on the request object.
// A JWT would also invite the usual JWT footguns (alg confusion, unverified
// decode) for no gain here. If a second token type ever appears, revisit.
// `@fastify/jwt` should be removed from package.json unless it earns its place.
//
// PROPERTIES
//   * HMAC-SHA256 over the payload, constant-time compared.
//   * Bound to one org id. A token for org A is rejected for org B.
//   * Expires (14 days). An abandoned draft's token dies with it.
//   * Stateless. No revocation — see LIMITATIONS at the bottom.
// ============================================================================

import { createHmac, timingSafeEqual } from 'crypto'

const VERSION = 'stad1'
export const DRAFT_TOKEN_HEADER = 'x-application-token'
export const DRAFT_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60 // 14 days
const MIN_SECRET_LENGTH = 32

/**
 * Read the signing secret. Deliberately fails closed and loudly: a default or
 * placeholder value here would make every token forgeable, which is worse than
 * a server that refuses to start. Read lazily (not at module load) so that
 * importing this module in a test or script does not require the secret until
 * a token is actually signed or verified.
 */
function secret(): string {
  const value = process.env.APPLICATION_TOKEN_SECRET
  if (!value || value.trim().length === 0) {
    throw new Error(
      'APPLICATION_TOKEN_SECRET is not set. The public application funnel cannot ' +
        'issue or verify draft tokens without it. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  }
  if (value.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(
      `APPLICATION_TOKEN_SECRET is too short (${value.trim().length} chars, minimum ${MIN_SECRET_LENGTH}). ` +
        'A guessable secret makes every application draft token forgeable.',
    )
  }
  return value.trim()
}

const b64url = (b: Buffer) => b.toString('base64url')

const httpError = (message: string, statusCode: number, code: string) =>
  Object.assign(new Error(message), { statusCode, code })

interface DraftTokenPayload {
  /** The org this token authorises. The only thing it grants access to. */
  orgId: string
  /** Issued at, seconds since epoch. */
  iat: number
  /** Expires at, seconds since epoch. */
  exp: number
}

function sign(payloadB64: string): string {
  return b64url(createHmac('sha256', secret()).update(`${VERSION}.${payloadB64}`).digest())
}

export interface IssuedDraftToken {
  token: string
  /** ISO-8601, for the client to display or schedule a refresh against. */
  expiresAt: string
}

export function issueDraftToken(orgId: string, now = new Date()): IssuedDraftToken {
  const iat = Math.floor(now.getTime() / 1000)
  const exp = iat + DRAFT_TOKEN_TTL_SECONDS
  const payload: DraftTokenPayload = { orgId, iat, exp }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return {
    token: `${VERSION}.${payloadB64}.${sign(payloadB64)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  }
}

/**
 * Verify a token and assert it authorises `expectedOrgId`.
 *
 * Throws a structured error (statusCode + code) for the global error handler.
 * Never returns a boolean — a caller that forgets to check a boolean fails
 * open, and this is the only thing standing in front of the KYB file.
 */
export function verifyDraftToken(
  rawToken: string | string[] | undefined,
  expectedOrgId: string,
  now = new Date(),
): DraftTokenPayload {
  if (Array.isArray(rawToken)) {
    throw httpError('Application token was supplied more than once', 400, 'draft_token_invalid')
  }
  const token = rawToken?.trim()
  if (!token) {
    throw httpError(
      `Application token required. Send the token returned by POST /api/applications in the ${DRAFT_TOKEN_HEADER} header.`,
      401,
      'draft_token_missing',
    )
  }

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw httpError('Application token is malformed', 401, 'draft_token_invalid')
  }
  const [, payloadB64, providedSig] = parts

  // Constant-time compare. Lengths must match before timingSafeEqual, and a
  // length mismatch is itself a rejection — not a leak, the length is fixed.
  const expectedSig = sign(payloadB64)
  const a = Buffer.from(providedSig)
  const b = Buffer.from(expectedSig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw httpError('Application token signature is invalid', 401, 'draft_token_invalid')
  }

  let payload: DraftTokenPayload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    throw httpError('Application token is malformed', 401, 'draft_token_invalid')
  }

  if (typeof payload?.orgId !== 'string' || typeof payload?.exp !== 'number') {
    throw httpError('Application token is malformed', 401, 'draft_token_invalid')
  }

  if (payload.exp * 1000 <= now.getTime()) {
    throw httpError(
      'Application token has expired. Start a new application to continue.',
      401,
      'draft_token_expired',
    )
  }

  // The binding check. A valid signature is not enough — the token must be for
  // THIS org, or a single real applicant could walk the whole tenant list.
  if (payload.orgId !== expectedOrgId) {
    throw httpError(
      'Application token is not valid for this application',
      403,
      'draft_token_org_mismatch',
    )
  }

  return payload
}

// ── LIMITATIONS (deliberate, documented rather than hidden) ─────────────────
// 1. No revocation. The token is stateless, so a leaked one stays valid until
//    it expires. Storing a token id on `organizations` and checking it would
//    fix this at the cost of a read per request; worth doing if drafts start
//    carrying more than they do now.
// 2. Bearer, not bound to a session or device. Whoever holds it is the
//    applicant. Anything that leaks it (a shared URL, a client-side log, a
//    referrer header) leaks the draft. It must live in a header, never a query
//    string — hence the header-only design.
// 3. Losing the token means losing the draft; there is no recovery path,
//    because any recovery path reachable with an org id recreates the IDOR this
//    closes. A resume link emailed to the verified primary contact is the right
//    answer and is a follow-up, not something to bolt on here.
