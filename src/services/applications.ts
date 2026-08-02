// ============================================================================
// applications.ts — Public application lifecycle (draft -> submit)
// ============================================================================
// No auth: a stranger with no account fills this in. All writes go through the
// service-role client (this backend). Drafts are keyed by the returned org id.
// An invite skips the queue (lane='invited') but NEVER skips verification.
// ============================================================================

import { randomUUID } from 'crypto'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { issueDraftToken } from '../lib/draftToken'
import { screenApplication, checkBlacklistReentry } from './screening'
import type { Organization } from '../types/vetting'

const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode })

// ── Validation ───────────────────────────────────────────────────────────────
const startSchema = z.object({
  inviteCode: z.string().trim().min(1).optional(),
  legal_name: z.string().trim().min(1, 'Legal name is required'),
  jurisdiction: z.string().trim().min(1, 'Jurisdiction is required'),
  primary_contact: z.object({
    email: z.string().email(),
    full_name: z.string().trim().min(1),
  }),
})

const companySchema = z.object({
  legal_name: z.string().trim().min(1).optional(),
  trading_name: z.string().trim().optional(),
  jurisdiction: z.string().trim().min(1).optional(),
  registry_number: z.string().trim().optional(),
  entity_type: z.string().trim().optional(),
  year_established: z.number().int().min(1800).max(2100).optional(),
  website: z.string().trim().url().optional().or(z.literal('')),
  address: z.record(z.string(), z.unknown()).optional(),
})

const tradingSchema = z.object({
  commodities: z.array(z.string()).default([]),
  sides: z.array(z.enum(['buy', 'sell', 'both'])).default([]),
  typical_volume: z.string().trim().optional(),
  typical_ticket: z.string().trim().optional(),
})

const principalSchema = z.object({
  is_principal: z.boolean(),
})

const historySchema = z.object({
  corridors: z.string().trim().optional(),
  years_active: z.number().int().min(0).max(200).optional(),
  references: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        company: z.string().trim().min(1),
        contact: z.string().trim().min(1),
      }),
    )
    .default([]),
})

const ownerSchema = z.object({
  full_name: z.string().trim().min(1),
  dob: z.string().trim().optional(),
  nationality: z.string().trim().optional(),
  ownership_pct: z.number().min(0).max(100).optional(),
})

const memberSchema = z.object({
  full_name: z.string().trim().min(1),
  email: z.string().email(),
  role: z.string().trim().optional(),
  is_signatory: z.boolean().optional(),
})

const submitSchema = z.object({
  accepted: z.literal(true, { message: 'You must confirm the information is accurate' }),
  authorized: z.literal(true, { message: 'You must authorize independent verification' }),
})

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png'])
const MAX_BYTES = 20 * 1024 * 1024

// ── Invite validation ────────────────────────────────────────────────────────
export async function validateInvite(code: string) {
  const { data, error } = await supabase
    .from('invitations')
    .select('*')
    .eq('code', code)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) return { valid: false as const, reason: 'not_found' }
  if (data.revoked_at) return { valid: false as const, reason: 'revoked' }
  if (data.redeemed_by) return { valid: false as const, reason: 'redeemed' }
  if (data.expires_at && new Date(data.expires_at) < new Date())
    return { valid: false as const, reason: 'expired' }

  return {
    valid: true as const,
    email: data.issued_to_email as string | null,
    name: data.issued_to_name as string | null,
  }
}

// ── Draft lifecycle ──────────────────────────────────────────────────────────
// NOTE: this loads an organization at ANY status. It is named `loadDraft` for
// historical reasons but it does not itself gate on status — `submitApplication`
// and `seedChecklist` both need to read the row after it has flipped to
// 'pending'. Every caller that must not touch a live org calls `assertDraft`.
async function loadDraft(orgId: string): Promise<Organization> {
  const { data, error } = await supabase.from('organizations').select('*').eq('id', orgId).single()
  if (error || !data) throw err('Application not found', 404)
  return data as Organization
}

function assertDraft(org: Organization) {
  if (org.status !== 'draft') throw err('Application already submitted and can no longer be edited', 409)
}

export async function startApplication(bodyIn: unknown) {
  const body = startSchema.parse(bodyIn)

  let lane: 'invited' | 'applied' = 'applied'
  let inviteCode: string | null = null
  let invitedBy: string | null = null

  if (body.inviteCode) {
    const inv = await validateInvite(body.inviteCode)
    if (!inv.valid) throw err(`Invite code is ${inv.reason}`, 400)
    lane = 'invited'
    inviteCode = body.inviteCode
    // Record who vouched (issuing member's org) for the accountability link.
    const { data: invRow } = await supabase
      .from('invitations')
      .select('issued_by, members:issued_by(org_id)')
      .eq('code', body.inviteCode)
      .maybeSingle()
    invitedBy = (invRow as any)?.members?.org_id ?? null
  }

  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .insert({
      legal_name: body.legal_name,
      jurisdiction: body.jurisdiction,
      status: 'draft',
      lane,
      invite_code_used: inviteCode,
      invited_by: invitedBy,
    })
    .select('id')
    .single()

  if (orgErr) throw new Error(orgErr.message)

  const { error: memErr } = await supabase.from('members').insert({
    org_id: org.id,
    email: body.primary_contact.email,
    full_name: body.primary_contact.full_name,
    is_admin: true, // primary contact is the org admin once provisioned
  })
  if (memErr) throw new Error(memErr.message)

  // The capability token for this draft. This is the ONLY point at which a
  // token is minted — there is deliberately no "get me a token for org X"
  // endpoint, because anything reachable with just an org id is the IDOR this
  // is closing. The client must keep it; it is required by every subsequent
  // /:orgId call and cannot be reissued.
  const { token, expiresAt } = issueDraftToken(org.id as string)

  return { orgId: org.id as string, lane, token, expiresAt }
}

export async function saveCompany(orgId: string, bodyIn: unknown) {
  assertDraft(await loadDraft(orgId))
  const patch = companySchema.parse(bodyIn)
  if (patch.website === '') patch.website = undefined
  return patchOrg(orgId, patch)
}

export async function saveTrading(orgId: string, bodyIn: unknown) {
  assertDraft(await loadDraft(orgId))
  const patch = tradingSchema.parse(bodyIn)
  return patchOrg(orgId, patch)
}

export async function savePrincipal(orgId: string, bodyIn: unknown) {
  assertDraft(await loadDraft(orgId))
  const patch = principalSchema.parse(bodyIn)
  return patchOrg(orgId, patch)
}

export async function saveHistory(orgId: string, bodyIn: unknown) {
  assertDraft(await loadDraft(orgId))
  const patch = historySchema.parse(bodyIn)
  return patchOrg(orgId, { trade_history: patch })
}

async function patchOrg(orgId: string, patch: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('organizations')
    .update(patch)
    .eq('id', orgId)
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data
}

// ── People ───────────────────────────────────────────────────────────────────
export async function addOwner(orgId: string, bodyIn: unknown) {
  assertDraft(await loadDraft(orgId))
  const o = ownerSchema.parse(bodyIn)
  const { data, error } = await supabase
    .from('beneficial_owners')
    .insert({ org_id: orgId, ...o })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function removeOwner(orgId: string, ownerId: string) {
  assertDraft(await loadDraft(orgId))
  const { error } = await supabase.from('beneficial_owners').delete().eq('id', ownerId).eq('org_id', orgId)
  if (error) throw new Error(error.message)
}

export async function addMember(orgId: string, bodyIn: unknown) {
  assertDraft(await loadDraft(orgId))
  const m = memberSchema.parse(bodyIn)
  const { data, error } = await supabase
    .from('members')
    .insert({ org_id: orgId, full_name: m.full_name, email: m.email, role: m.role, is_signatory: m.is_signatory ?? false })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data
}

// ── Documents ────────────────────────────────────────────────────────────────
export async function uploadDocument(orgId: string, file: {
  docType: string
  filename: string
  mimeType: string
  buffer: Buffer
}) {
  assertDraft(await loadDraft(orgId))

  if (!ALLOWED_MIME.has(file.mimeType)) throw err('Only PDF, JPEG, or PNG files are allowed', 415)
  if (file.buffer.length > MAX_BYTES) throw err('File exceeds the 20MB limit', 413)
  if (!file.docType?.trim()) throw err('doc_type is required', 400)

  const safeName = file.filename.replace(/[^\w.\-]+/g, '_').slice(-120)
  const path = `${orgId}/${file.docType}/${randomUUID()}-${safeName}`

  const { error: upErr } = await supabase.storage
    .from('application-docs')
    .upload(path, file.buffer, { contentType: file.mimeType, upsert: false })
  if (upErr) throw new Error(upErr.message)

  const { data, error } = await supabase
    .from('application_documents')
    .insert({
      org_id: orgId,
      doc_type: file.docType,
      file_path: path,
      original_name: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.buffer.length,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data
}

// ── Fetch (resume draft) ─────────────────────────────────────────────────────
/**
 * Resume an in-progress application.
 *
 * SECURITY: this endpoint is reachable with nothing but an org UUID, so it must
 * only ever expose a DRAFT the applicant is still filling in. It previously
 * loaded an organization at any status and returned its beneficial owners (name,
 * DOB, nationality, ownership %), member emails and document records — meaning
 * an org id was enough to read the KYB file of an approved, live member firm.
 *
 * Anything past 'draft' is now reported as 404 rather than 403/409: a status
 * code that distinguishes "exists but not yours" from "does not exist" turns
 * this into an existence oracle for member org ids, which is itself a leak on a
 * platform whose premise is that counterparty identity is not public.
 */
export async function getApplication(orgId: string) {
  const org = await loadDraft(orgId)
  if (org.status !== 'draft') throw err('Application not found', 404)

  const [{ data: owners }, { data: members }, { data: docs }] = await Promise.all([
    supabase.from('beneficial_owners').select('*').eq('org_id', orgId),
    supabase.from('members').select('*').eq('org_id', orgId),
    supabase.from('application_documents').select('*').eq('org_id', orgId),
  ])
  return { org, owners: owners ?? [], members: members ?? [], documents: docs ?? [] }
}

/**
 * Status-only view, available at any status.
 *
 * `getApplication` is draft-only, which would otherwise leave an applicant who
 * has just submitted with no way to see what happened to their application.
 * This is the replacement: it is token-gated like everything else under
 * /:orgId, and it returns a deliberately minimal projection — no beneficial
 * owners, no member emails, no documents. Widening this projection re-opens the
 * leak that commit dbb3723 closed, so don't.
 */
export async function getApplicationStatus(orgId: string) {
  const org = await loadDraft(orgId)
  return {
    orgId: org.id,
    legal_name: org.legal_name,
    status: org.status,
    lane: org.lane,
    submitted_at: (org as { attestation?: { at?: string } }).attestation?.at ?? null,
  }
}

// ── Submit ───────────────────────────────────────────────────────────────────
export async function submitApplication(orgId: string, bodyIn: unknown, ip: string) {
  const org = await loadDraft(orgId)
  assertDraft(org)
  submitSchema.parse(bodyIn)

  // Completeness gate
  const missing: string[] = []
  if (!org.legal_name) missing.push('legal_name')
  if (!org.jurisdiction) missing.push('jurisdiction')
  if (org.is_principal === null || org.is_principal === undefined) missing.push('principal_status')
  const { count: ownerCount } = await supabase
    .from('beneficial_owners')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
  if (!ownerCount) missing.push('beneficial_owners')
  if (missing.length) throw err(`Application incomplete: ${missing.join(', ')}`, 422)

  const { data: updated, error: upErr } = await supabase
    .from('organizations')
    .update({
      status: 'pending',
      attestation: { accepted: true, authorized: true, ip, at: new Date().toISOString() },
    })
    .eq('id', orgId)
    .eq('status', 'draft')
    .select('id, legal_name, jurisdiction')
    .single()
  if (upErr) throw new Error(upErr.message)

  // Seed the reviewer's checklist: one pending check per required item.
  await seedChecklist(orgId)

  // Fire screening (never blocks) + blacklist re-entry.
  try {
    await screenApplication(updated as any)
    await checkBlacklistReentry(orgId)
  } catch (e) {
    // Screening failures must not roll back a valid submission; the reviewer
    // will see a pending/degraded check and can re-run.
    console.error('screening error (non-fatal):', e)
  }

  return { orgId, status: 'pending' as const }
}

// A pending check for every required verification item, so the admin checklist
// renders 1:1 from verification_checks.
async function seedChecklist(orgId: string) {
  const required = ['kyb_registry', 'beneficial_ownership', 'principal_status', 'video_interview']
  const rows: Array<{ subject_type: 'org'; subject_id: string; check_type: string; status: 'pending' }> =
    required.map((check_type) => ({
      subject_type: 'org' as const,
      subject_id: orgId,
      check_type,
      status: 'pending' as const,
    }))
  // trade references become their own pending checks
  const org = await loadDraft(orgId)
  const refs = org.trade_history?.references ?? []
  refs.forEach(() =>
    rows.push({
      subject_type: 'org' as const,
      subject_id: orgId,
      check_type: 'trade_reference',
      status: 'pending' as const,
    }),
  )
  await supabase.from('verification_checks').insert(rows)
}
