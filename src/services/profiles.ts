import { supabase } from '../lib/supabase'
import { Profile } from '../types'

export async function getProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (error || !data) throw Object.assign(new Error('Profile not found'), { statusCode: 404 })
  return data
}

/**
 * Another member's profile.
 *
 * Projection corrected to the deployed table: `roles`, `is_verified` and
 * `trust_score` do not exist on `profiles` (the real columns are `role` and
 * `verification_status`), so this returned a PostgREST error on every call.
 *
 * Note what is deliberately NOT selected: `email`, `phone`, `location` and
 * `is_admin`. `select('*')` here would hand a member's contact details and
 * platform-admin status to any other authenticated user.
 */
export async function getPublicProfile(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, company_name, avatar_url, role, verification_status, bio')
    .eq('id', userId)
    .maybeSingle()

  if (error || !data) throw Object.assign(new Error('Profile not found'), { statusCode: 404 })
  return data
}

// Only these fields may be set through the profile patch. This is a security
// boundary: the service-role client bypasses RLS, so a blind spread of client
// input would let a caller set is_admin / trust_score / verification_status /
// is_verified etc. We explicitly whitelist-pick instead. `null` clears a value.
export async function upsertProfile(userId: string, patch: {
  full_name?: string
  bio?: string | null
  avatar_url?: string | null
  company_name?: string | null
  phone?: string | null
  location?: string | null
}): Promise<Profile> {
  if (patch.full_name !== undefined && !patch.full_name.trim()) {
    throw Object.assign(new Error('full_name cannot be empty'), { statusCode: 400 })
  }

  const update: Record<string, unknown> = {
    id: userId,
    updated_at: new Date().toISOString(),
  }
  if (patch.full_name !== undefined) update.full_name = patch.full_name
  if (patch.bio !== undefined) update.bio = patch.bio
  // `roles` was in this whitelist but there is no `roles` column on the
  // deployed profiles table (it has `role`, singular, which is NOT self-service
  // — it is set by admin flows). Accepting it made every PATCH that included it
  // fail at the database. Dropped rather than remapped to `role`: letting a
  // member choose their own `role` value is a different decision and not one to
  // make silently.
  if (patch.avatar_url !== undefined) update.avatar_url = patch.avatar_url
  if (patch.company_name !== undefined) update.company_name = patch.company_name
  if (patch.phone !== undefined) update.phone = patch.phone
  if (patch.location !== undefined) update.location = patch.location

  const { data, error } = await supabase
    .from('profiles')
    .upsert(update)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

// ── Avatar (routes Supabase storage through the backend) ─────────────────────
const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const AVATAR_MAX_BYTES = 5 * 1024 * 1024 // UI claims 5MB; enforce it server-side

// Given a stored public URL, recover the object key inside a bucket so we can
// delete it. Mirrors the client's `url.split('/<bucket>/')[1]` behaviour.
function objectPathFromPublicUrl(url: string | undefined | null, bucket: string): string | null {
  if (!url) return null
  const marker = `/${bucket}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  return url.slice(idx + marker.length) || null
}

export async function uploadAvatar(userId: string, file: {
  buffer: Buffer
  filename: string
  mimetype: string
}): Promise<Profile> {
  if (!AVATAR_MIME.has(file.mimetype)) {
    throw Object.assign(new Error('Avatar must be a JPEG, PNG, GIF, or WEBP image'), { statusCode: 415 })
  }
  if (file.buffer.length > AVATAR_MAX_BYTES) {
    throw Object.assign(new Error('Avatar exceeds the 5MB limit'), { statusCode: 413 })
  }

  // Best-effort delete of the previous avatar object.
  const current = await getProfile(userId)
  const oldPath = objectPathFromPublicUrl(current.avatar_url, 'avatars')
  if (oldPath) {
    await supabase.storage.from('avatars').remove([oldPath])
  }

  const ext = (file.filename.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'png'
  const path = `${userId}/avatar_${Date.now()}.${ext}`

  const { error: upErr } = await supabase.storage
    .from('avatars')
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: true, cacheControl: '3600' })
  if (upErr) throw new Error(upErr.message)

  const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path)

  return upsertProfile(userId, { avatar_url: publicUrl })
}

export async function removeAvatar(userId: string): Promise<Profile> {
  const current = await getProfile(userId)
  const oldPath = objectPathFromPublicUrl(current.avatar_url, 'avatars')
  if (oldPath) {
    await supabase.storage.from('avatars').remove([oldPath])
  }
  return upsertProfile(userId, { avatar_url: null })
}

/** Hard server-side ceiling. A client may ask for fewer, never more. */
const SEARCH_MAX_LIMIT = 50
const SEARCH_DEFAULT_LIMIT = 20
const MIN_SEARCH_LENGTH = 2

/**
 * Member directory search.
 *
 * This was a bulk export of the member directory:
 *
 *     GET /api/profiles/search?q=&limit=100000
 *
 * `limit` was taken from the query string and passed to `.limit()` unbounded,
 * and an empty `q` produced `ilike '%%'`, which matches every row. So one
 * request returned the entire member list of an invite-only platform whose
 * whole premise is that you do not get to see who else is on it. Three things
 * were needed, and all three matter:
 *
 *   1. a server-side cap on `limit` — the client does not get to choose;
 *   2. a minimum query length, so search must be search and not enumeration;
 *   3. escaping of LIKE metacharacters, without which `q=%` or `q=__` sails
 *      through the length check and still matches everything. Fixing (2)
 *      without (3) is not a fix.
 *
 * The projection is also corrected here: it selected `trust_score`,
 * `is_verified` and `roles`, none of which exist on the deployed `profiles`
 * table, so this endpoint returned a PostgREST error rather than data. The real
 * columns are `verification_status` and `role`. Matches the projection used by
 * deals.searchCounterparties (320552d).
 */
export async function searchProfiles(query: string, limit = SEARCH_DEFAULT_LIMIT) {
  const trimmed = (query ?? '').trim()
  if (trimmed.length < MIN_SEARCH_LENGTH) {
    throw Object.assign(
      new Error(`Search query must be at least ${MIN_SEARCH_LENGTH} characters`),
      { statusCode: 400 },
    )
  }

  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), SEARCH_MAX_LIMIT)
    : SEARCH_DEFAULT_LIMIT

  // Escape PostgREST/LIKE pattern metacharacters so a query of '%' or '__'
  // cannot match everything despite passing the length check.
  const pattern = `%${trimmed.replace(/[%_\\]/g, (c) => `\\${c}`)}%`

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, company_name, avatar_url, verification_status, role')
    .or(`full_name.ilike.${pattern},company_name.ilike.${pattern}`)
    .limit(safeLimit)

  if (error) throw new Error(error.message)
  return data ?? []
}

// ── Verification request (replaces the client's direct storage + table writes)
const VERIFICATION_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png'])
const VERIFICATION_MAX_BYTES = 20 * 1024 * 1024 // matches the multipart limit

export async function requestVerification(
  userId: string,
  files: Array<{ buffer: Buffer; filename: string; mimetype: string }> = [],
): Promise<Profile> {
  // Upload each document to the verification-docs bucket; keep the public URLs
  // (matching what the client used to store).
  const documents: string[] = []
  const ts = Date.now()
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!VERIFICATION_MIME.has(file.mimetype)) {
      throw Object.assign(new Error('Documents must be PDF, JPEG, or PNG'), { statusCode: 415 })
    }
    if (file.buffer.length > VERIFICATION_MAX_BYTES) {
      throw Object.assign(new Error('Document exceeds the 20MB limit'), { statusCode: 413 })
    }
    const safeName = file.filename.replace(/[^\w.\-]+/g, '_').slice(-120)
    const path = `${userId}/${ts}_${i}_${safeName}`
    const { error: upErr } = await supabase.storage
      .from('verification-docs')
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false })
    if (upErr) throw new Error(upErr.message)
    const { data: { publicUrl } } = supabase.storage.from('verification-docs').getPublicUrl(path)
    documents.push(publicUrl)
  }

  const now = new Date().toISOString()

  const { error: reqErr } = await supabase
    .from('verification_requests')
    .upsert(
      { user_id: userId, status: 'pending', documents, requested_at: now },
      { onConflict: 'user_id' },
    )
  if (reqErr) throw new Error(reqErr.message)

  // Reflect the pending request on the profile. These fields are set here,
  // server-side — they are NOT in upsertProfile's whitelist, so a client can
  // never set them itself.
  const { data, error } = await supabase
    .from('profiles')
    .update({ verification_status: 'pending', verification_requested_at: now, updated_at: now })
    .eq('id', userId)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}
