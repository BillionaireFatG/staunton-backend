// ============================================================================
// onboarding.ts — Module 2: verified -> operational
// ============================================================================
// The authenticated org member completes terms, profile, team, and capacity,
// then reaches `provisional`. Promotion to `full` is a separate admin/gated
// transition (promote_to_full RPC). Capacity verification is admin-only and
// feeds Module 3's funds_verified badge via a verification_checks row.
// ============================================================================

import { z } from 'zod'
import { supabase } from '../lib/supabase'

const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode })

export const CURRENT_TERMS_VERSION = '2026-07-01'

// Resolve the caller's org (and member id) from their auth user id.
async function callerOrg(userId: string): Promise<{ orgId: string; memberId: string }> {
  const { data, error } = await supabase
    .from('members')
    .select('id, org_id')
    .eq('auth_user_id', userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw err('No organization membership for this user', 403)
  return { orgId: data.org_id, memberId: data.id }
}

async function ensureProgressRow(orgId: string) {
  await supabase.from('onboarding_progress').upsert({ org_id: orgId }, { onConflict: 'org_id' })
}

// ── State (drives the wizard) ────────────────────────────────────────────────
export async function getState(userId: string) {
  const { orgId } = await callerOrg(userId)
  await ensureProgressRow(orgId)
  const [{ data: org }, { data: progress }, { data: profile }, { data: capacity }, { data: members }] =
    await Promise.all([
      supabase.from('organizations').select('*').eq('id', orgId).single(),
      supabase.from('onboarding_progress').select('*').eq('org_id', orgId).single(),
      supabase.from('org_profiles').select('*').eq('org_id', orgId).maybeSingle(),
      supabase.from('financial_capacity').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
      supabase.from('members').select('*').eq('org_id', orgId).order('created_at'),
    ])
  return {
    org,
    progress,
    profile: profile ?? null,
    capacity: capacity ?? [],
    members: members ?? [],
    terms_version: CURRENT_TERMS_VERSION,
  }
}

// ── Accept terms ─────────────────────────────────────────────────────────────
export async function acceptTerms(userId: string) {
  const { orgId } = await callerOrg(userId)
  await ensureProgressRow(orgId)
  const { error } = await supabase
    .from('onboarding_progress')
    .update({
      terms_accepted_at: new Date().toISOString(),
      terms_version: CURRENT_TERMS_VERSION,
      auth_provisioned: true, // they are logged in, so auth is provisioned
    })
    .eq('org_id', orgId)
  if (error) throw new Error(error.message)
  return { accepted: true, version: CURRENT_TERMS_VERSION }
}

// ── Complete profile (auto-generates the anonymized label) ───────────────────
const profileSchema = z.object({
  display_name: z.string().trim().min(1),
  bio: z.string().trim().optional(),
  regions: z.array(z.string()).default([]),
  capabilities: z.record(z.string(), z.unknown()).optional(),
})

export async function saveProfile(userId: string, bodyIn: unknown) {
  const { orgId } = await callerOrg(userId)
  const body = profileSchema.parse(bodyIn)

  const { data: org } = await supabase
    .from('organizations')
    .select('commodities, sides')
    .eq('id', orgId)
    .single()

  const anonymized_label = buildAnonymizedLabel({
    commodities: org?.commodities ?? [],
    sides: org?.sides ?? [],
    region: body.regions[0],
  })

  const { data, error } = await supabase
    .from('org_profiles')
    .upsert(
      {
        org_id: orgId,
        display_name: body.display_name,
        bio: body.bio,
        regions: body.regions,
        capabilities: body.capabilities ?? {},
        anonymized_label,
        profile_complete: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id' },
    )
    .select('*')
    .single()
  if (error) throw new Error(error.message)

  await ensureProgressRow(orgId)
  await supabase.from('onboarding_progress').update({ profile_completed: true }).eq('org_id', orgId)
  return data
}

function buildAnonymizedLabel(p: { commodities: string[]; sides: string[]; region?: string }): string {
  const commodity = (p.commodities[0] ?? 'commodity').replace(/_/g, ' ')
  const side = p.sides.includes('both') || (p.sides.includes('buy') && p.sides.includes('sell'))
    ? 'trader'
    : p.sides.includes('sell')
      ? 'seller'
      : p.sides.includes('buy')
        ? 'buyer'
        : 'counterparty'
  const region = p.region ? `, ${p.region}` : ''
  return `Verified ${commodity} ${side}${region}`
}

// ── Invite a team member (inherits org status; still needs own KYC) ──────────
const memberInviteSchema = z.object({
  email: z.string().email(),
  full_name: z.string().trim().min(1),
  role: z.string().trim().optional(),
  is_signatory: z.boolean().optional(),
})

export async function inviteMember(userId: string, bodyIn: unknown) {
  const { orgId, memberId } = await callerOrg(userId)
  // Only an org admin can add members.
  const { data: me } = await supabase.from('members').select('is_admin').eq('id', memberId).single()
  if (!me?.is_admin) throw err('Only an org admin can invite members', 403)

  const body = memberInviteSchema.parse(bodyIn)
  const { data, error } = await supabase
    .from('members')
    .insert({
      org_id: orgId,
      email: body.email,
      full_name: body.full_name,
      role: body.role,
      is_signatory: body.is_signatory ?? false,
      kyc_status: 'pending', // new members act only after individual KYC
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)

  await ensureProgressRow(orgId)
  await supabase.from('onboarding_progress').update({ members_invited: true }).eq('org_id', orgId)
  return data
}

// ── Submit capacity (POP/POF/escrow) — goes to admin verification ────────────
const capacitySchema = z.object({
  capacity_type: z.enum(['pop', 'pof', 'escrow_balance', 'lc_facility']),
  amount: z.number().positive().optional(),
  currency: z.string().default('USD'),
  // Enum-constrained to bank-verifiable sources only. Free-format SWIFT is not
  // an option here by design.
  source_type: z.enum(['bank_confirmation', 'escrow_provider', 'lc_facility_letter']),
  document_id: z.string().uuid().optional(),
  expires_at: z.string().optional(),
})

export async function submitCapacity(userId: string, bodyIn: unknown) {
  const { orgId } = await callerOrg(userId)
  const body = capacitySchema.parse(bodyIn)
  const { data, error } = await supabase
    .from('financial_capacity')
    .insert({
      org_id: orgId,
      capacity_type: body.capacity_type,
      amount: body.amount,
      currency: body.currency,
      source_type: body.source_type,
      document_id: body.document_id,
      expires_at: body.expires_at,
      verification_status: 'pending',
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)

  await ensureProgressRow(orgId)
  await supabase.from('onboarding_progress').update({ capacity_submitted: true }).eq('org_id', orgId)
  return data
}

// ── Complete onboarding (gates the wizard's final step) ──────────────────────
export async function completeOnboarding(userId: string) {
  const { orgId } = await callerOrg(userId)
  const { data: p } = await supabase.from('onboarding_progress').select('*').eq('org_id', orgId).single()
  const missing: string[] = []
  if (!p?.terms_accepted_at) missing.push('terms')
  if (!p?.profile_completed) missing.push('profile')
  if (!p?.capacity_submitted) missing.push('capacity')
  if (missing.length) throw err(`Onboarding incomplete: ${missing.join(', ')}`, 422)

  const { error } = await supabase
    .from('onboarding_progress')
    .update({ completed_at: new Date().toISOString() })
    .eq('org_id', orgId)
  if (error) throw new Error(error.message)
  return { completed: true }
}

// ── Admin: verify capacity + promote to full ─────────────────────────────────
import { actingMemberId } from '../middleware/requireAdmin'

export async function verifyCapacity(
  adminUserId: string,
  capacityId: string,
  outcome: 'verified' | 'rejected',
  notes?: string,
) {
  const memberId = await actingMemberId(adminUserId)
  const { data: cap, error } = await supabase
    .from('financial_capacity')
    .update({
      verification_status: outcome,
      verified_by: memberId,
      verified_at: new Date().toISOString(),
    })
    .eq('id', capacityId)
    .select('*')
    .single()
  if (error || !cap) throw err('Capacity record not found', 404)

  // Feed Module 3: a verified, unexpired capacity earns funds_verified.
  if (outcome === 'verified') {
    await supabase.from('verification_checks').insert({
      subject_type: 'org',
      subject_id: cap.org_id,
      check_type: 'funds_verified',
      status: 'pass',
      method: 'bank_confirmation',
      verified_by: memberId,
      verified_at: new Date().toISOString(),
      notes: notes ?? `Capacity ${cap.capacity_type} verified.`,
    })
  }
  return cap
}

export async function promoteToFull(adminUserId: string, orgId: string, overrideReason?: string) {
  const memberId = await actingMemberId(adminUserId)
  const { error } = await supabase.rpc('promote_to_full', {
    p_org: orgId,
    p_admin_member: memberId,
    p_override_reason: overrideReason ?? null,
  })
  if (error) throw err(error.message, 422)
  return { status: 'full' as const }
}
