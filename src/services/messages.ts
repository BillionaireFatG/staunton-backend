// ============================================================================
// messages.ts — direct conversations, per-deal threads, and global chat
// ============================================================================
// SCHEMA NOTE (read this before editing a query here)
//
// Every query in this module used to target a `conversations` table with a
// `participant_ids uuid[]` column and a `messages.is_read` flag. Neither exists.
// The deployed table (Frontend migration 003) is a two-column pair —
// `participant_1` / `participant_2`, ordered by `last_message_at` — and the
// message flag is `read`. So every endpoint in this domain returned a PostgREST
// error. Corrected to the deployed shape, the same way the loyalty service was
// corrected in cfa6d8f, and re-verified against the live database on 2 Aug 2026.
//
// The pair is normalised (least uuid first) before insert so that a
// conversation between A and B is one row, not two, and so the table's partial
// unique indexes (migration 0009 Part E) actually do their job.
//
// AUTHORIZATION. The service-role client bypasses RLS, so every gate in this
// file is the ONLY gate. Two of them:
//   * ensureParticipant()  — anything keyed on a conversation id.
//   * deals.getDeal()      — anything keyed on a deal id. Reused rather than
//     reimplemented, so the buyer/seller/broker predicate lives in one place.
// ============================================================================

import { supabase } from '../lib/supabase'
import { getDeal } from './deals'
import { Conversation, ConversationSummary, GlobalMessage, Message } from '../types'

const err = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode })

const CONVERSATION_COLUMNS = 'id, participant_1, participant_2, deal_id, last_message_at, created_at'

/** Attach the derived `participants` array clients read. */
function withParticipants<T extends { participant_1: string; participant_2: string }>(row: T) {
  return { ...row, participants: [row.participant_1, row.participant_2] }
}

/** Stable ordering, so {A,B} and {B,A} are the same row. */
function pair(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA]
}

/**
 * Guard for any id interpolated into a PostgREST `.or()` filter.
 *
 * These filters are built by string concatenation because PostgREST offers no
 * parameter binding for them. The ids concerned come from a validated JWT or
 * from the database, so none is attacker-controlled today — but "today" is the
 * operative word, and a comma or a dot in one of these strings rewrites the
 * filter rather than failing. Cheap to assert, so assert it.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function assertUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw err(`${label} must be a UUID`, 400)
  return value
}

const clampLimit = (limit: number | undefined, fallback: number, max: number) =>
  Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit as number), 1), max) : fallback

// ── Direct conversations ────────────────────────────────────────────────────

export async function getOrCreateConversation(userA: string, userB: string): Promise<Conversation> {
  // userA is always req.userId. userB is client-supplied, so it is checked here
  // rather than trusted: unchecked, a caller could create rows referencing
  // arbitrary ids, including their own (a self-conversation whose unread
  // accounting is nonsense) or ids belonging to nothing at all.
  if (!userB || typeof userB !== 'string') throw err('recipient_id is required', 400)
  if (userA === userB) throw err('Cannot start a conversation with yourself', 400)

  const { data: recipient } = await supabase.from('profiles').select('id').eq('id', userB).maybeSingle()
  if (!recipient) throw err('Recipient not found', 404)

  return upsertConversation(userA, userB, null)
}

/**
 * Find-or-create the one conversation for a pair (and optionally a deal).
 *
 * `deal_id is null` / `deal_id = X` is matched explicitly rather than left
 * loose: since 0009 a pair may hold both a plain DM and one thread per deal, so
 * "the conversation for these two" is no longer a unique question without it.
 */
async function upsertConversation(userA: string, userB: string, dealId: string | null): Promise<Conversation> {
  const [p1, p2] = pair(userA, userB)

  let find = supabase
    .from('conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('participant_1', p1)
    .eq('participant_2', p2)
  find = dealId === null ? find.is('deal_id', null) : find.eq('deal_id', dealId)

  const { data: existing } = await find.maybeSingle()
  if (existing) return withParticipants(existing) as Conversation

  const { data, error } = await supabase
    .from('conversations')
    .insert({ participant_1: p1, participant_2: p2, deal_id: dealId })
    .select(CONVERSATION_COLUMNS)
    .single()

  if (error) {
    // 23505 = unique_violation. Two concurrent opens of the same thread race
    // here; the partial unique indexes from 0009 make the loser fail rather than
    // create a duplicate. Re-read instead of surfacing a 500 — the row the
    // caller wanted now exists, which is the outcome they asked for.
    if ((error as { code?: string }).code === '23505') {
      let retry = supabase
        .from('conversations')
        .select(CONVERSATION_COLUMNS)
        .eq('participant_1', p1)
        .eq('participant_2', p2)
      retry = dealId === null ? retry.is('deal_id', null) : retry.eq('deal_id', dealId)
      const { data: raced } = await retry.maybeSingle()
      if (raced) return withParticipants(raced) as Conversation
    }
    throw new Error(error.message)
  }
  return withParticipants(data) as Conversation
}

/**
 * The caller's conversation index.
 *
 * PREVIOUSLY: `.select('..., last_message:messages(content, created_at, sender_id)')`.
 * A PostgREST embed returns the ENTIRE child collection, not the newest row —
 * the name `last_message` was aspirational. So this endpoint shipped every
 * message of every conversation the caller had, on every render of the inbox.
 * Same unbounded-query class already fixed in deals.ts and profiles/search, and
 * it grows with usage.
 *
 * Now one call to conversation_list() (migration 0009 Part G), which does the
 * DISTINCT ON for the genuine last message, the grouped COUNT for per-
 * conversation unread, and the counterparty join — none of which PostgREST can
 * express. That RPC is SECURITY DEFINER and service_role-only; `userId` comes
 * from the validated JWT and is never client-supplied.
 */
export async function getConversations(userId: string, limit = 50): Promise<ConversationSummary[]> {
  const { data, error } = await supabase.rpc('conversation_list', {
    p_user: assertUuid(userId, 'userId'),
    p_limit: clampLimit(limit, 50, 100),
  })

  if (error) throw new Error(error.message)

  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    id: r.id,
    participant_1: r.participant_1,
    participant_2: r.participant_2,
    participants: [r.participant_1, r.participant_2],
    deal_id: r.deal_id ?? null,
    last_message_at: r.last_message_at,
    created_at: r.created_at,
    unread_count: r.unread_count ?? 0,
    // Null when the counterparty's profile row has been deleted. Clients must
    // handle that rather than assume it is present.
    counterparty: r.counterparty_id
      ? {
          id: r.counterparty_id,
          full_name: r.counterparty_name ?? null,
          company_name: r.counterparty_company ?? null,
          avatar_url: r.counterparty_avatar_url ?? null,
        }
      : null,
    last_message: r.last_message_id
      ? {
          id: r.last_message_id,
          conversation_id: r.id,
          content: r.last_message_content,
          sender_id: r.last_message_sender_id,
          created_at: r.last_message_created_at,
        }
      : null,
  }))
}

export async function getMessages(conversationId: string, userId: string, limit = 50, before?: string): Promise<Message[]> {
  await ensureParticipant(conversationId, userId)

  // Clamped here as well as at the route. The route is the input boundary, but
  // this is the last line before the query and a future caller may not go
  // through that route.
  const safeLimit = clampLimit(limit, 50, 100)

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
 */
export async function getTotalUnreadCount(userId: string): Promise<number> {
  const safeId = assertUuid(userId, 'userId')

  const { data: convos, error: convErr } = await supabase
    .from('conversations')
    .select('id')
    .or(`participant_1.eq.${safeId},participant_2.eq.${safeId}`)

  if (convErr) throw new Error(convErr.message)

  const ids = (convos ?? []).map((c) => c.id as string)
  if (ids.length === 0) return 0

  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .in('conversation_id', ids)
    .neq('sender_id', safeId)
    .eq('read', false)

  if (error) throw new Error(error.message)
  return count ?? 0
}

// ── Per-deal threads ────────────────────────────────────────────────────────

/**
 * The conversation attached to a deal — the negotiation record sitting with the
 * transaction it belongs to.
 *
 * Authorization is `deals.getDeal()`, reused deliberately rather than
 * reimplemented: it is the one place the buyer/seller/broker predicate lives,
 * and it already 404s (not 403s) for a non-party so the endpoint is not an
 * existence oracle for deal ids. A second copy of that predicate here would be
 * a second thing to keep correct.
 *
 * The thread is between the caller and the OTHER principal. A deal with a broker
 * has three parties and this two-column table cannot represent a three-way
 * thread — see the note in the throw below; that is a schema question, not
 * something to paper over by silently dropping a party from the conversation.
 */
export async function getOrCreateDealConversation(dealId: string, userId: string): Promise<Conversation> {
  const deal = await getDeal(dealId, userId) // 404s for a non-party

  const parties = [
    deal.buyer_id,
    deal.seller_id,
    (deal as { broker_id?: string | null }).broker_id,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)

  const others = [...new Set(parties)].filter((p) => p !== userId)

  if (others.length === 0) {
    throw err('This deal has no counterparty to open a thread with', 409)
  }
  if (others.length > 1) {
    // Fail closed and loudly rather than guess which of two counterparties the
    // caller meant. Three-party deal threads need a participants table, not a
    // participant_1/participant_2 pair; picking one silently would produce a
    // negotiation record that is missing a party — worse than no thread.
    throw err(
      'This deal has more than one counterparty; multi-party deal threads are not supported yet',
      409,
    )
  }

  return upsertConversation(userId, others[0], deal.id)
}

// ── Global chat ─────────────────────────────────────────────────────────────
//
// `global_messages` had no backend at all: the table existed and the browser
// talked to it directly, which violates the three-layer rule (master §7). It is
// also the table whose RLS policy was `FOR SELECT USING (true)` with no role
// list — verified live as readable by the browser-shipped anon key, i.e. the
// entire global chat of an invite-only trading platform was public. Migration
// 0009 Part B scopes that policy to `authenticated` and revokes anon outright;
// these functions are the supported path.

const GLOBAL_COLUMNS = 'id, sender_id, content, created_at'
const GLOBAL_SENDER = 'sender:profiles(id, full_name, company_name, avatar_url)'

/**
 * Global chat backlog, newest-last, keyset-paginated.
 *
 * Bounded on both axes. `before` is a created_at cursor rather than an offset:
 * stable under concurrent inserts, and no deep-offset scan. Same pattern as
 * getDeals().
 *
 * The sender projection carries no email or phone — a chat line needs a name
 * and a face, not contact details.
 */
export async function getGlobalMessages(limit = 50, before?: string): Promise<GlobalMessage[]> {
  let query = supabase
    .from('global_messages')
    .select(`${GLOBAL_COLUMNS}, ${GLOBAL_SENDER}`)
    .order('created_at', { ascending: false })
    .limit(clampLimit(limit, 50, 100))

  if (before) query = query.lt('created_at', before)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown as GlobalMessage[]).reverse()
}

/**
 * Post to global chat.
 *
 * `sender_id` is req.userId, never taken from the body — the same rule as every
 * other write in this codebase. Content is trimmed and bounded at the route and
 * again here.
 */
export async function sendGlobalMessage(senderId: string, content: string): Promise<GlobalMessage> {
  const body = (content ?? '').trim()
  if (!body) throw err('content is required', 400)
  if (body.length > 4000) throw err('Message exceeds 4000 characters', 400)

  const { data, error } = await supabase
    .from('global_messages')
    .insert({ sender_id: senderId, content: body })
    .select(`${GLOBAL_COLUMNS}, ${GLOBAL_SENDER}`)
    .single()

  if (error) throw new Error(error.message)
  return data as unknown as GlobalMessage
}

// ── Gates ───────────────────────────────────────────────────────────────────

/** The authorization gate for everything keyed on a conversation id. */
async function ensureParticipant(conversationId: string, userId: string) {
  const { data, error } = await supabase
    .from('conversations')
    .select('participant_1, participant_2')
    .eq('id', conversationId)
    .maybeSingle()

  if (error || !data) throw err('Conversation not found', 404)
  if (data.participant_1 !== userId && data.participant_2 !== userId) {
    // 404 rather than 403: a 403 confirms the conversation exists.
    throw err('Conversation not found', 404)
  }
}
