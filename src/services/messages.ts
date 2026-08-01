import { supabase } from '../lib/supabase'
import { Conversation, Message } from '../types'

export async function getOrCreateConversation(userA: string, userB: string): Promise<Conversation> {
  // Look for existing conversation between these two users
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .contains('participant_ids', [userA, userB])
    .limit(1)
    .single()

  if (existing) return existing

  const { data, error } = await supabase
    .from('conversations')
    .insert({ participant_ids: [userA, userB] })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function getConversations(userId: string): Promise<Conversation[]> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*, last_message:messages(content, created_at, sender_id)')
    .contains('participant_ids', [userId])
    .order('updated_at', { ascending: false })

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getMessages(conversationId: string, userId: string, limit = 50, before?: string): Promise<Message[]> {
  await ensureParticipant(conversationId, userId)

  let query = supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (before) query = query.lt('created_at', before)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []).reverse()
}

export async function sendMessage(conversationId: string, senderId: string, content: string): Promise<Message> {
  await ensureParticipant(conversationId, senderId)

  const { data, error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: senderId, content })
    .select()
    .single()

  if (error) throw new Error(error.message)

  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId)

  return data
}

export async function markAsRead(conversationId: string, userId: string): Promise<void> {
  await ensureParticipant(conversationId, userId)

  const { error } = await supabase
    .from('messages')
    .update({ is_read: true })
    .eq('conversation_id', conversationId)
    .neq('sender_id', userId)
    .eq('is_read', false)

  if (error) throw new Error(error.message)
}

export async function getTotalUnreadCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .neq('sender_id', userId)
    .eq('is_read', false)

  if (error) throw new Error(error.message)
  return count ?? 0
}

async function ensureParticipant(conversationId: string, userId: string) {
  const { data, error } = await supabase
    .from('conversations')
    .select('participant_ids')
    .eq('id', conversationId)
    .single()

  if (error || !data) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })
  if (!data.participant_ids.includes(userId)) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
}
