// ============================================================================
// roles.ts — Module 3 roles & effective permissions
// ============================================================================
// Permissions resolve through ONE server-side function: has_permission
// (role grants ∩ org status). Roles are assigned by platform admins, or by an
// org admin for org-scoped roles within their own org.
// ============================================================================

import { z } from 'zod'
import { supabase } from '../lib/supabase'

const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode })

// The single permission gate — call this everywhere.
export async function hasPermission(userId: string, permission: string, orgId?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_permission', {
    p_user: userId,
    p_permission: permission,
    p_org: orgId ?? null,
  })
  if (error) throw new Error(error.message)
  return data === true
}

export async function listRoles() {
  const [{ data: roles }, { data: perms }] = await Promise.all([
    supabase.from('roles').select('*').order('scope'),
    supabase.from('role_permissions').select('*'),
  ])
  const byRole = new Map<string, string[]>()
  for (const p of perms ?? []) {
    const arr = byRole.get(p.role_id) ?? []
    arr.push(p.permission_key)
    byRole.set(p.role_id, arr)
  }
  return (roles ?? []).map((r: any) => ({ ...r, permissions: byRole.get(r.id) ?? [] }))
}

export async function getMemberRoles(orgId: string) {
  const { data, error } = await supabase
    .from('member_roles')
    .select('*, roles(key, label, scope), members(full_name, email)')
    .eq('org_id', orgId)
    .is('revoked_at', null)
  if (error) throw new Error(error.message)
  return data ?? []
}

const assignSchema = z.object({
  member_id: z.string().uuid(),
  role_key: z.string().min(1),
  org_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
})

export async function assignRole(actorUserId: string, bodyIn: unknown) {
  const body = assignSchema.parse(bodyIn)

  const { data: role } = await supabase.from('roles').select('id, scope').eq('key', body.role_key).maybeSingle()
  if (!role) throw err(`Unknown role: ${body.role_key}`, 400)

  const { data: target } = await supabase.from('members').select('id, org_id').eq('id', body.member_id).maybeSingle()
  if (!target) throw err('Member not found', 404)
  const orgId = body.org_id ?? target.org_id

  // Authorization: platform admin (admin.assign_role) OR org admin of this org.
  const isPlatform = await hasPermission(actorUserId, 'admin.assign_role')
  let allowed = isPlatform
  if (!allowed) {
    const { data: actor } = await supabase
      .from('members')
      .select('id, org_id, is_admin')
      .eq('auth_user_id', actorUserId)
      .maybeSingle()
    // An org admin may assign ORG-scoped roles within their own org only.
    allowed = !!actor?.is_admin && actor.org_id === orgId && role.scope === 'org'
  }
  if (!allowed) throw err('Not authorized to assign this role', 403)

  const { data: actorMember } = await supabase
    .from('members')
    .select('id')
    .eq('auth_user_id', actorUserId)
    .maybeSingle()

  const { data, error } = await supabase
    .from('member_roles')
    .insert({
      member_id: body.member_id,
      role_id: role.id,
      org_id: orgId,
      deal_id: body.deal_id ?? null,
      granted_by: actorMember?.id ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function revokeRole(actorUserId: string, memberRoleId: string) {
  const { data: mr } = await supabase.from('member_roles').select('org_id').eq('id', memberRoleId).maybeSingle()
  if (!mr) throw err('Role grant not found', 404)

  const isPlatform = await hasPermission(actorUserId, 'admin.assign_role')
  let allowed = isPlatform
  if (!allowed) {
    const { data: actor } = await supabase
      .from('members')
      .select('org_id, is_admin')
      .eq('auth_user_id', actorUserId)
      .maybeSingle()
    allowed = !!actor?.is_admin && actor.org_id === mr.org_id
  }
  if (!allowed) throw err('Not authorized to revoke this role', 403)

  const { error } = await supabase
    .from('member_roles')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', memberRoleId)
  if (error) throw new Error(error.message)
}
