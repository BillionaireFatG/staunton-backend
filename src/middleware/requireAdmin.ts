import { FastifyRequest, FastifyReply } from 'fastify'
import { supabase } from '../lib/supabase'

// Platform-admin guard. Runs AFTER `authenticate` (which sets req.userId).
// Module 1 uses profiles.is_admin as the platform-admin signal; Module 3
// formalizes platform roles (platform_admin / verifier / support).
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', req.userId)
    .single()

  if (error || !data?.is_admin) {
    return reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Platform admin access required',
    })
  }
}

// The acting admin's members row id (for verification_checks.verified_by), or
// null if the admin isn't a member of any org (platform staff commonly aren't).
export async function actingMemberId(userId: string): Promise<string | null> {
  const { data } = await supabase.from('members').select('id').eq('auth_user_id', userId).maybeSingle()
  return data?.id ?? null
}
