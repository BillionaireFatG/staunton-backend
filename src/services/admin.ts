// ============================================================================
// admin.ts — Admin queue, verification checklist, screening review, decisions
// ============================================================================
// Every mutation records WHO / HOW / WHEN into the append-only
// verification_checks trail. Approval is a server-side transaction (RPC) plus
// auth-user provisioning via the Supabase Admin API.
// ============================================================================

import { randomBytes } from 'crypto'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { actingMemberId } from '../middleware/requireAdmin'

const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode })

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000'

// ── Queue ────────────────────────────────────────────────────────────────────
export async function getQueue(filters: { status?: string } = {}) {
  let q = supabase.from('admin_application_queue').select('*').order('created_at', { ascending: false })
  if (filters.status) q = q.eq('status', filters.status)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

// ── Detail ───────────────────────────────────────────────────────────────────
export async function getApplicationDetail(orgId: string) {
  const { data: org, error } = await supabase.from('organizations').select('*').eq('id', orgId).single()
  if (error || !org) throw err('Application not found', 404)

  const [{ data: members }, { data: owners }, { data: documents }, { data: checks }, { data: interview }] =
    await Promise.all([
      supabase.from('members').select('*').eq('org_id', orgId).order('created_at'),
      supabase.from('beneficial_owners').select('*').eq('org_id', orgId).order('created_at'),
      supabase.from('application_documents').select('*').eq('org_id', orgId).order('uploaded_at'),
      supabase
        .from('verification_checks')
        .select('*')
        .or(`and(subject_type.eq.org,subject_id.eq.${orgId})`)
        .order('created_at', { ascending: false }),
      supabase.from('video_interviews').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ])

  // Owner-subject checks + screenings (subject_id = owner ids)
  const ownerIds = (owners ?? []).map((o: any) => o.id)
  const [{ data: ownerChecks }, { data: screenings }] = await Promise.all([
    ownerIds.length
      ? supabase.from('verification_checks').select('*').eq('subject_type', 'owner').in('subject_id', ownerIds)
      : Promise.resolve({ data: [] as any[] }),
    supabase
      .from('screening_results')
      .select('*')
      .or(`and(subject_type.eq.org,subject_id.eq.${orgId})${ownerIds.length ? `,and(subject_type.eq.owner,subject_id.in.(${ownerIds.join(',')}))` : ''}`)
      .order('screened_at', { ascending: false }),
  ])

  return {
    org,
    members: members ?? [],
    owners: owners ?? [],
    documents: documents ?? [],
    checks: [...(checks ?? []), ...(ownerChecks ?? [])],
    screenings: screenings ?? [],
    interview: interview ?? null,
  }
}

// ── Insert a verification check (append-only) ────────────────────────────────
const checkSchema = z.object({
  subject_type: z.enum(['org', 'member', 'owner', 'listing', 'document', 'deal']),
  subject_id: z.string().uuid(),
  check_type: z.string().min(1),
  status: z.enum(['pending', 'pass', 'fail', 'flagged']),
  method: z.string().optional(),
  notes: z.string().optional(),
  evidence_url: z.string().url().optional().or(z.literal('')),
})

export async function insertCheck(userId: string, bodyIn: unknown) {
  const body = checkSchema.parse(bodyIn)
  const memberId = await actingMemberId(userId)
  const { data, error } = await supabase
    .from('verification_checks')
    .insert({
      subject_type: body.subject_type,
      subject_id: body.subject_id,
      check_type: body.check_type,
      status: body.status,
      method: body.method,
      notes: body.notes,
      evidence_url: body.evidence_url || null,
      verified_by: memberId,
      verified_at: new Date().toISOString(),
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data
}

// ── Review a screening match ─────────────────────────────────────────────────
const reviewSchema = z.object({
  screening_id: z.string().uuid(),
  outcome: z.enum(['no_match', 'false_positive', 'true_match']),
  notes: z.string().optional(),
})

export async function reviewScreening(userId: string, bodyIn: unknown) {
  const body = reviewSchema.parse(bodyIn)
  const memberId = await actingMemberId(userId)

  const { data: screening, error: sErr } = await supabase
    .from('screening_results')
    .update({ review_outcome: body.outcome, reviewed_by: memberId })
    .eq('id', body.screening_id)
    .select('*')
    .single()
  if (sErr || !screening) throw err('Screening not found', 404)

  // Append the human decision as a sanctions_screening check on the same subject.
  const checkStatus = body.outcome === 'true_match' ? 'fail' : 'pass'
  await supabase.from('verification_checks').insert({
    subject_type: screening.subject_type,
    subject_id: screening.subject_id,
    check_type: 'sanctions_screening',
    status: checkStatus,
    method: 'opensanctions_api',
    verified_by: memberId,
    verified_at: new Date().toISOString(),
    notes: `Screening reviewed: ${body.outcome}.${body.notes ? ' ' + body.notes : ''}`,
  })

  return screening
}

// ── Video interview scoresheet ───────────────────────────────────────────────
const interviewSchema = z.object({
  org_id: z.string().uuid(),
  conducted_at: z.string().optional(),
  recording_url: z.string().url().optional().or(z.literal('')),
  consent_given: z.boolean().optional(),
  identity_matched: z.boolean().optional(),
  domain_score: z.number().int().min(0).max(100).optional(),
  behavioral_flags: z.array(z.string()).optional(),
  outcome: z.enum(['pass', 'fail', 'follow_up']).optional(),
  notes: z.string().optional(),
})

export async function saveInterview(userId: string, bodyIn: unknown) {
  const body = interviewSchema.parse(bodyIn)
  const memberId = await actingMemberId(userId)

  const { data, error } = await supabase
    .from('video_interviews')
    .insert({
      org_id: body.org_id,
      conducted_by: memberId,
      conducted_at: body.conducted_at ?? new Date().toISOString(),
      recording_url: body.recording_url || null,
      consent_given: body.consent_given ?? false,
      identity_matched: body.identity_matched ?? null,
      domain_score: body.domain_score ?? null,
      behavioral_flags: body.behavioral_flags ?? [],
      outcome: body.outcome ?? null,
      notes: body.notes ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)

  // A completed interview appends the video_interview check reflecting outcome.
  if (body.outcome) {
    await supabase.from('verification_checks').insert({
      subject_type: 'org',
      subject_id: body.org_id,
      check_type: 'video_interview',
      status: body.outcome === 'pass' ? 'pass' : body.outcome === 'fail' ? 'fail' : 'flagged',
      method: 'founder_video_call',
      verified_by: memberId,
      verified_at: new Date().toISOString(),
      notes: `Interview outcome: ${body.outcome}. Domain score: ${body.domain_score ?? 'n/a'}.`,
    })
  }
  return data
}

export async function getInterviewQuestions(commodity?: string) {
  let q = supabase.from('interview_questions').select('*').order('commodity').order('sort_order')
  if (commodity) q = q.in('commodity', ['general', commodity])
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

// ── Invitations ──────────────────────────────────────────────────────────────
const inviteSchema = z.object({
  issued_to_email: z.string().email().optional(),
  issued_to_name: z.string().optional(),
  note: z.string().optional(),
  expires_in_days: z.number().int().min(1).max(90).optional(),
})

/**
 * Human-typable single-use invite code, e.g. STN-7F3K-9QXM.
 *
 * An invite code is a bearer credential: presenting a valid one at
 * /api/applications/validate-invite skips the public queue and puts the holder
 * in the `invited` lane. It must therefore be unguessable.
 *
 * It was generated with `Math.random()`. That is a fast non-cryptographic PRNG
 * (V8 uses xorshift128+) whose internal state can be recovered from a modest run
 * of observed outputs, after which every past and future code is derivable. Codes
 * are also handed to outsiders by design, so an attacker gets samples for free
 * just by being invited once — and the endpoint that tests a code was, until
 * this pass, unauthenticated and unthrottled.
 *
 * `randomBytes` instead, with rejection sampling: taking `byte % 31` over a
 * 31-character alphabet would bias the first 8 characters (256 = 8*31 + 8), and
 * bias shrinks the effective keyspace. Values in the non-uniform tail are
 * discarded and redrawn.
 *
 * Keyspace is unchanged at 31^8 ≈ 8.5e11.
 */
function makeCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 31 chars; no I/L/O/0/1
  const limit = 256 - (256 % alphabet.length) // 248 — reject bytes at or above

  const rand = (n: number) => {
    let out = ''
    while (out.length < n) {
      for (const byte of randomBytes(n * 2)) {
        if (byte >= limit) continue // discard, would bias the distribution
        out += alphabet[byte % alphabet.length]
        if (out.length === n) break
      }
    }
    return out
  }

  return `STN-${rand(4)}-${rand(4)}`
}

export async function issueInvite(userId: string, bodyIn: unknown) {
  const body = inviteSchema.parse(bodyIn)
  const memberId = await actingMemberId(userId)
  const expires_at = body.expires_in_days
    ? new Date(Date.now() + body.expires_in_days * 86400_000).toISOString()
    : new Date(Date.now() + 14 * 86400_000).toISOString()

  const { data, error } = await supabase
    .from('invitations')
    .insert({
      code: makeCode(),
      issued_by: memberId,
      issued_to_email: body.issued_to_email,
      issued_to_name: body.issued_to_name,
      note: body.note,
      expires_at,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listInvites() {
  const { data, error } = await supabase.from('invitations').select('*').order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function revokeInvite(id: string) {
  const { error } = await supabase.from('invitations').update({ revoked_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Signed URL for a private document ────────────────────────────────────────
export async function signedUrl(filePath: string) {
  const { data, error } = await supabase.storage.from('application-docs').createSignedUrl(filePath, 120)
  if (error || !data) throw err('Could not sign document URL', 404)
  return { url: data.signedUrl, expires_in: 120 }
}

// ── Decisions ────────────────────────────────────────────────────────────────
export async function decide(userId: string, orgId: string, decision: string, reason?: string) {
  switch (decision) {
    case 'approve':
      return approve(userId, orgId)
    case 'reject':
      return simpleDecision(userId, orgId, 'rejected', 'rejection', reason ?? 'Application rejected.')
    case 'blacklist':
      return simpleDecision(userId, orgId, 'blacklisted', 'blacklist', reason ?? 'Organization blacklisted.')
    case 'request_info':
      // Stays pending; record the request in the trail.
      await supabase.from('verification_checks').insert({
        subject_type: 'org',
        subject_id: orgId,
        check_type: 'info_requested',
        status: 'flagged',
        method: 'admin_decision',
        verified_by: await actingMemberId(userId),
        verified_at: new Date().toISOString(),
        notes: reason ?? 'Additional information requested.',
      })
      return { status: 'pending' as const }
    default:
      throw err(`Unknown decision: ${decision}`, 400)
  }
}

async function simpleDecision(
  userId: string,
  orgId: string,
  newStatus: 'rejected' | 'blacklisted',
  checkType: string,
  notes: string,
) {
  const memberId = await actingMemberId(userId)
  const { error } = await supabase.from('organizations').update({ status: newStatus }).eq('id', orgId)
  if (error) throw new Error(error.message)
  await supabase.from('verification_checks').insert({
    subject_type: 'org',
    subject_id: orgId,
    check_type: checkType,
    status: newStatus === 'blacklisted' ? 'fail' : 'flagged',
    method: 'admin_decision',
    verified_by: memberId,
    verified_at: new Date().toISOString(),
    notes,
  })
  return { status: newStatus }
}

async function approve(userId: string, orgId: string) {
  const memberId = await actingMemberId(userId)

  // Atomic: verify required checks pass + promote to provisional + audit row.
  const { data, error } = await supabase.rpc('approve_organization', {
    p_org: orgId,
    p_admin_member: memberId,
  })
  if (error) {
    // The RPC raises check_violation with a human-readable message on a missing
    // or failing required check.
    throw err(error.message, 422)
  }
  const primary = (data as any[])?.[0]
  if (!primary?.primary_email) throw err('Approved, but no primary contact found to provision', 500)

  // Provision the auth user + send the setup link.
  const setup = await provisionPrimary(primary.primary_member_id, primary.primary_email)

  return { status: 'provisional' as const, setup }
}

async function provisionPrimary(memberId: string, email: string) {
  const redirectTo = `${APP_URL}/onboarding`

  // Preferred path: invite email (magic setup link) — requires SMTP configured.
  const invited = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo })
  if (!invited.error && invited.data?.user) {
    await supabase.from('members').update({ auth_user_id: invited.data.user.id }).eq('id', memberId)
    return { emailed: true as const, action_link: null as string | null }
  }

  // Fallback: create the user and generate an action link the admin can send
  // manually (e.g. when SMTP isn't configured in this environment).
  const created = await supabase.auth.admin.createUser({ email, email_confirm: false })
  if (created.error || !created.data?.user) {
    throw err(`Auth provisioning failed: ${created.error?.message ?? 'unknown'}`, 502)
  }
  await supabase.from('members').update({ auth_user_id: created.data.user.id }).eq('id', memberId)

  const link = await supabase.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } })
  return {
    emailed: false as const,
    action_link: link.error ? null : link.data?.properties?.action_link ?? null,
  }
}
