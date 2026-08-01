import { supabase } from '../lib/supabase'
import { VoiceRoom, VoiceParticipant, Message } from '../types'

export async function getVoiceRooms(): Promise<(VoiceRoom & { participant_count: number })[]> {
  const { data, error } = await supabase
    .from('voice_rooms')
    .select('*, participants:voice_participants(count)')
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => ({
    ...r,
    participant_count: r.participants?.[0]?.count ?? 0,
  }))
}

export async function getVoiceRoom(roomId: string): Promise<VoiceRoom> {
  const { data, error } = await supabase
    .from('voice_rooms')
    .select('*')
    .eq('id', roomId)
    .single()

  if (error || !data) throw Object.assign(new Error('Room not found'), { statusCode: 404 })
  return data
}

export async function getRoomParticipants(roomId: string): Promise<VoiceParticipant[]> {
  const { data, error } = await supabase
    .from('voice_participants')
    .select('*, profile:profiles(id, full_name, avatar_url, trust_score)')
    .eq('room_id', roomId)

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function joinRoom(roomId: string, userId: string): Promise<void> {
  await getVoiceRoom(roomId)

  const { error } = await supabase.from('voice_participants').upsert({
    room_id: roomId,
    user_id: userId,
    is_muted: false,
    is_speaking: false,
  }, { onConflict: 'room_id,user_id' })

  if (error) throw new Error(error.message)
}

export async function leaveRoom(roomId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('voice_participants')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', userId)

  if (error) throw new Error(error.message)
}

export async function updateParticipantStatus(roomId: string, userId: string, patch: { is_muted?: boolean; is_speaking?: boolean }): Promise<void> {
  const { error } = await supabase
    .from('voice_participants')
    .update(patch)
    .eq('room_id', roomId)
    .eq('user_id', userId)

  if (error) throw new Error(error.message)
}

export async function getRoomMessages(roomId: string, limit = 50): Promise<Message[]> {
  const { data, error } = await supabase
    .from('voice_room_messages')
    .select('*, sender:profiles(id, full_name, avatar_url)')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error(error.message)
  return (data ?? []).reverse()
}

export async function sendRoomMessage(roomId: string, senderId: string, content: string): Promise<Message> {
  await getVoiceRoom(roomId)

  const { data, error } = await supabase
    .from('voice_room_messages')
    .insert({ room_id: roomId, sender_id: senderId, content })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}
