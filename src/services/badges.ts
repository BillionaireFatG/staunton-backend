// ============================================================================
// badges.ts — Module 3 badge display (derived from verification_checks)
// ============================================================================
// Badges are granted by the DB trigger, never here. This service only READS
// them, and enforces visibility at the API layer:
//   • own org  → all active badges + what's missing and how to earn it
//   • other org (authenticated) → active badges only (pre-reveal safe: no identity)
//   • public / logged out → nothing (route requires auth)
// ============================================================================

import { supabase } from '../lib/supabase'

const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode })

async function orgForUser(userId: string): Promise<string> {
  const { data } = await supabase.from('members').select('org_id').eq('auth_user_id', userId).maybeSingle()
  if (!data) throw err('No organization membership for this user', 403)
  return data.org_id
}

// Own org: granted + missing (with how-to-earn).
export async function getMyBadges(userId: string) {
  const orgId = await orgForUser(userId)
  const [{ data: defs }, { data: active }] = await Promise.all([
    supabase.from('badge_definitions').select('*').neq('category', 'listing').order('category'),
    supabase.from('org_badges').select('*').eq('org_id', orgId).is('revoked_at', null),
  ])
  const activeByKey = new Map((active ?? []).map((b: any) => [b.badge_key, b]))
  return (defs ?? []).map((d: any) => {
    const grant = activeByKey.get(d.key)
    return {
      key: d.key,
      label: d.label,
      description: d.description,
      icon: d.icon,
      category: d.category,
      granted: !!grant,
      granted_at: grant?.granted_at ?? null,
      expires_at: grant?.expires_at ?? null,
      requires_check_types: d.requires_check_types, // how to earn it
    }
  })
}

// Another org (pre-reveal safe): active badges only, no identity fields.
export async function getOrgBadges(orgId: string) {
  const { data } = await supabase
    .from('org_badges')
    .select('badge_key, granted_at, expires_at, badge_definitions(label, description, icon, category)')
    .eq('org_id', orgId)
    .is('revoked_at', null)
  return (data ?? []).map((b: any) => ({
    key: b.badge_key,
    label: b.badge_definitions?.label,
    description: b.badge_definitions?.description,
    icon: b.badge_definitions?.icon,
    category: b.badge_definitions?.category,
    granted_at: b.granted_at,
    expires_at: b.expires_at,
  }))
}
