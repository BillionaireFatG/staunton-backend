// ============================================================================
// messages.ts — direct conversations between two members
// ============================================================================
// SCHEMA NOTE (read this before editing a query here)
//
// Every query in this module used to target a `conversations` table with a
// `participant_ids uuid[]` column and a `messages.is_read` flag. Neither exists.
// The deployed table (Frontend migration 003) is a two-column pair —
// `participant_1` / `participant_2`, ordered by `last_message_at` — and the
// message flag is `read`. So every endpoint in this domain returned a PostgREST
// error. Corrected here to the deployed shape, the same way the loyalty service
// was corrected in cfa6d8f.
//
// The pair is normalised (least uuid first) before insert so that a
// conversation between A and B is one row, not two, and so the table's
// UNIQUE(participant_1, participant_2) constraint actually does its job.
// ============================================================================

import { supabase } from '../lib/supabase'
import { Conversation, Message } from '../types'

const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode })

const CONVERSATION_COLUMNS = 'id, participant_1, participant_2, last_message_at, created_at'

/** Attach the derived `participants` array clients read. */
function withParticipants<T extends { participant_1: string; participant_2: string }>(row: T) {
  return { ...row, participants: [row.participant_1, row.participant_2] }
}

/** Stable ordering, so {A,B} and {B,A} are the same row. */
function pair(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA]
}

export async function getOrCreateConversation(userA: string, userB: string): Promise<Conversation> {
  // userA is always req.userId. userB is client-supplied, so it is checked here
  // rather than trusted: unchecked, a caller could create rows referencing
  // arbitrary ids, including their own (a self-conversation whose unread
  // accounting is nonsense) or ids belonging to nothing at all.
  if (!userB || typeof userB !== 'string') throw err('recipient_id is required', 400)
  if (userA === userB) throw err('Cannot start a conversation with yourself', 400)

  const { data: recipient } = await supabase.from('profiles').select('id').eq('id', userB).maybeSingle()
  if (!recipient) throw err('Recipient not found', 404)

  const [p1, p2] = pair(userA, userB)

  const { data: existing } = await supabase
    .from('conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('participant_1', p1)
    .eq('participant_2', p2)
    .maybeSingle()

  if (existing) return withParticipants(existing) as Conversation

  const { data, error } = await supabase
    .from('conversations')
    .insert({ participant_1: p1, participant_2: p2 })
    .select(CONVERSATION_COLUMNS)
    .single()

  if (error) throw new Error(error.message)
  return withParticipants(data) as Conversation
}

export async function getConversations(userId: string): Promise<Conversation[]> {
  const { data, error } = await supabase
    .from('conversations')
    .select(`${CONVERSATION_COLUMNS}, last_message:messages(content, created_at, sender_id)`)
    .or(`participant_1.eq.${userId},participant_2.eq.${userId}`)
    .order('last_message_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => withParticipants(r as any)) as Conversation[]
}

export async function getMessages(conversationId: string, userId: string, limit = 50, before?: string): Promise<Message[]> {
  await ensureParticipant(conversationId, userId)

  // Clamped here as well as at the route. The route is the input boundary, but
  // this is the last line before the query and a future caller may not go
  // through that route.
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 50

  let query = supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(safeLimit)

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
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId)

  return data
}

export async function markAsRead(conversationId: string, userId: string): Promise<void> {
  await ensureParticipant(conversationId, userId)

  const { error } = await supabase
    .from('messages')
    .update({ read: true })
    .eq('conversation_id', conversationId)
    .neq('sender_id', userId)
    .eq('read', false)

  if (error) throw new Error(error.message)
}

/**
 * Unread messages in the caller's OWN conversations.
 *
 * This previously counted every unread message on the platform that the caller
 * had not sent, with no conversation scoping whatsoever:
 *
 *     .from('messages').select(count).neq('sender_id', userId).eq('is_read', false)
 *
 * The number itself is the disclosure — a badge that moves whenever any two
 * strangers message each other is a live readout of total platform activity, and
 * on a private, invite-only trading network that is precisely what is not
 * supposed to be observable. It was also just wrong: the badge never matched the
 * inbox it sat above.
 *
 * Scoped by fetching the caller's conversation ids first. Two round trips, and
 * the `in` list grows with the caller's conversation count; if inboxes get large
 * this wants a single SQL count behind an RPC. Correctness first.
 */
export async function getTotalUnreadCount(userId: string): Promise<number> {
  const { data: convos, error: convErr } = await supabase
    .from('conversations')
    .select('id')
    .or(`participant_1.eq.${userId},participant_2.eq.${userId}`)

  if (convErr) throw new Error(convErr.message)

  const ids = (convos ?? []).map((c) => c.id as string)
  if (ids.length === 0) return 0

  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .in('conversation_id', ids)
    .neq('sender_id', userId)
    .eq('read', false)

  if (error) throw new Error(error.message)
  return count ?? 0
}

/** The authorization gate for everything keyed on a conversation id. */
async function ensureParticipant(conversationId: string, userId: string) {
  const { data, error } = await supabase
    .from('conversations')
    .select('participant_1, participant_2')
    .eq('id', conversationId)
    .maybeSingle()

  if (error || !data) throw err('Conversation not found', 404)
  if (data.participant_1 !== userId && data.participant_2 !== userId) {
    throw err('Conversation not found', 404)
  }
}
