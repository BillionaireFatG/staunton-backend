// ============================================================================
// voice.ts — voice rooms, participants and room chat
// ============================================================================
// AUTHORIZATION MODEL
//
// Every route here already required a valid Supabase JWT, and that was the only
// check: being *some* authenticated user was treated as authorization to read
// any room, read its participant list, read its entire message history and post
// into it, by id. On a platform whose premise is that counterparty identity is
// not revealed pre-deal, a room's participant list is itself the disclosure —
// it says which firms are in the market for what.
//
// The deployed schema offers exactly one access signal, `voice_rooms.is_public`,
// so that is what this uses:
//
//   * public room  — any authenticated user may read it and join it.
//   * private room — only an existing `voice_participants` row grants access.
//     There is no way to self-join a private room through this API; membership
//     has to be established elsewhere. That fails closed, which is the right
//     default until there is a real invitation model for private rooms.
//
// Posting is stricter than reading: you must actually be in the room. Reading a
// room you can see is one thing; speaking into it without joining is not.
//
// CAVEAT, and it is a real one: `voice_rooms.agora_channel_name` is the channel
// clients hand to the Agora SDK, and this backend mints no Agora token, so
// whatever authorizes the actual audio session happens client-side and outside
// these checks. Gating the channel name here raises the bar but is not a
// substitute for a server-side Agora token service. Flagged, not fixed.
// ============================================================================

import { supabase } from '../lib/supabase'
import { VoiceRoom, VoiceParticipant, Message } from '../types'

const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode })

/** Raw room fetch with no access check. Never expose this directly. */
async function loadRoom(roomId: string): Promise<VoiceRoom> {
  const { data, error } = await supabase.from('voice_rooms').select('*').eq('id', roomId).single()
  if (error || !data) throw err('Room not found', 404)
  return data
}

async function isParticipant(roomId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('voice_participants')
    .select('id')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle()
  return !!data
}

/**
 * The gate. Returns the room if the caller may see it, otherwise throws.
 *
 * A caller with no access gets 404, not 403 — a 403 confirms the room exists and
 * turns this into an enumeration oracle for private rooms.
 */
async function assertRoomAccess(roomId: string, userId: string): Promise<VoiceRoom> {
  const room = await loadRoom(roomId)
  // Fail closed: anything not explicitly public is private.
  if (room.is_public === true) return room
  if (await isParticipant(roomId, userId)) return room
  throw err('Room not found', 404)
}

/** Rooms the caller may see: public ones, plus private ones they are already in. */
export async function getVoiceRooms(userId: string): Promise<(VoiceRoom & { participant_count: number })[]> {
  const { data: mine } = await supabase
    .from('voice_participants')
    .select('room_id')
    .eq('user_id', userId)
  const joinedIds = [...new Set((mine ?? []).map((r) => r.room_id as string))]

  // public OR already a participant
  const filter = joinedIds.length
    ? `is_public.eq.true,id.in.(${joinedIds.join(',')})`
    : 'is_public.eq.true'

  const { data, error } = await supabase
    .from('voice_rooms')
    .select('*, participants:voice_participants(count)')
    .or(filter)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => ({
    ...r,
    participant_count: r.participants?.[0]?.count ?? 0,
  }))
}

export async function getVoiceRoom(roomId: string, userId: string): Promise<VoiceRoom> {
  return assertRoomAccess(roomId, userId)
}

export async function getRoomParticipants(roomId: string, userId: string): Promise<VoiceParticipant[]> {
  await assertRoomAccess(roomId, userId)

  const { data, error } = await supabase
    .from('voice_participants')
    .select('*, profile:profiles(id, full_name, avatar_url)')
    .eq('room_id', roomId)

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function joinRoom(roomId: string, userId: string): Promise<void> {
  // Public rooms are joinable; a private room cannot be self-joined, because
  // assertRoomAccess only passes a caller who is already a participant.
  await assertRoomAccess(roomId, userId)

  const { error } = await supabase.from('voice_participants').upsert({
    room_id: roomId,
    user_id: userId,
    is_muted: false,
    is_speaking: false,
  }, { onConflict: 'room_id,user_id' })

  if (error) throw new Error(error.message)
}

export async function leaveRoom(roomId: string, userId: string): Promise<void> {
  // No access check: this only ever deletes the caller's own row, and a caller
  // must be able to leave a room even if their access has since been revoked.
  const { error } = await supabase
    .from('voice_participants')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', userId)

  if (error) throw new Error(error.message)
}

/**
 * Update the caller's own participant row.
 *
 * The request body used to be forwarded into `.update()` unfiltered. The
 * service-role client bypasses RLS, so `{"user_id": "<someone else>"}` rewrote
 * the row's owner — reassigning the caller's presence to another user and
 * leaving the caller holding a row keyed to an id they do not own. `id`,
 * `room_id` and `joined_at` were writable the same way.
 *
 * Fields are now picked explicitly and type-checked here, in the service. The
 * route's `req.body as { is_muted?: boolean }` cast was never a control: a type
 * assertion is a compile-time fiction that checks nothing at runtime.
 */
export async function updateParticipantStatus(
  roomId: string,
  userId: string,
  patch: unknown,
): Promise<void> {
  const input = (patch ?? {}) as Record<string, unknown>
  const update: { is_muted?: boolean; is_speaking?: boolean } = {}

  if (input.is_muted !== undefined) {
    if (typeof input.is_muted !== 'boolean') throw err('is_muted must be a boolean', 400)
    update.is_muted = input.is_muted
  }
  if (input.is_speaking !== undefined) {
    if (typeof input.is_speaking !== 'boolean') throw err('is_speaking must be a boolean', 400)
    update.is_speaking = input.is_speaking
  }
  if (Object.keys(update).length === 0) {
    throw err('Nothing to update: provide is_muted and/or is_speaking', 400)
  }

  const { error } = await supabase
    .from('voice_participants')
    .update(update)
    .eq('room_id', roomId)
    .eq('user_id', userId) // the caller's own row, never a client-supplied id

  if (error) throw new Error(error.message)
}

const MAX_MESSAGE_LIMIT = 100

export async function getRoomMessages(roomId: string, userId: string, limit = 50): Promise<Message[]> {
  await assertRoomAccess(roomId, userId)

  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), MAX_MESSAGE_LIMIT)
    : 50

  const { data, error } = await supabase
    .from('voice_room_messages')
    .select('*, sender:profiles(id, full_name, avatar_url)')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(safeLimit)

  if (error) throw new Error(error.message)
  return (data ?? []).reverse()
}

export async function sendRoomMessage(roomId: string, senderId: string, content: unknown): Promise<Message> {
  await assertRoomAccess(roomId, senderId)

  // Stricter than reading: you must be in the room to speak in it.
  if (!(await isParticipant(roomId, senderId))) {
    throw err('Join the room before posting a message', 403)
  }

  if (typeof content !== 'string' || !content.trim()) throw err('content is required', 400)
  if (content.length > 4000) throw err('Message exceeds 4000 characters', 400)

  const { data, error } = await supabase
    .from('voice_room_messages')
    .insert({ room_id: roomId, sender_id: senderId, content: content.trim() })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}
