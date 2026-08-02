export type DealStatus =
  | 'draft'
  | 'pending'
  | 'active'
  | 'injecting'
  | 'inspection'
  | 'completed'
  | 'cancelled'
  | 'disputed'

export type LoyaltyTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond'

export interface Deal {
  id: string
  created_at: string
  updated_at: string
  status: DealStatus
  buyer_id: string
  seller_id: string
  commodity: string
  quantity: number
  price: number
  location: string
  notes?: string
}

export interface DealEvent {
  id: string
  deal_id: string
  created_at: string
  type: string
  payload: Record<string, unknown>
  created_by: string
}

// Mirrors the DEPLOYED `profiles` table, column for column. Verified against
// the live database via PostgREST, not read off a migration file — migration
// 011 dropped and recreated tables and several migrations describe columns that
// were never applied.
//
// Removed from this interface: `roles: string[]`, `is_verified: boolean` and
// `trust_score: number`. None of the three exists in production. They were
// declared REQUIRED here, so every consumer was type-safe against a shape the
// database cannot return — `profile.trust_score` compiled and was always
// `undefined`. Singular `role` is the real column.
//
// `email` and `is_admin` are real, and are deliberately NOT included in the
// projections returned by GET /api/profiles/search or GET /api/profiles/:id.
// They appear here because GET /api/profiles/me returns the caller's own row.
export interface Profile {
  id: string
  created_at: string
  updated_at?: string
  full_name: string
  email?: string
  avatar_url?: string | null
  role?: string | null
  is_admin?: boolean
  bio?: string | null
  company_name?: string | null
  phone?: string | null
  location?: string | null
  verification_status?: string
  verification_requested_at?: string | null
  verified_at?: string | null
}

// Mirrors the `user_loyalty` table (Frontend migration 007_loyalty_rewards.sql).
export interface LoyaltyState {
  id: string
  user_id: string
  tier: LoyaltyTier
  total_points: number
  available_points: number
  lifetime_points: number
  deals_completed: number
  total_volume_usd: number
  current_streak: number
  longest_streak: number
  tier_progress: number
  next_tier_threshold: number
  joined_at: string
  tier_updated_at: string
  created_at: string
  updated_at: string
}

// Mirrors the `loyalty_transactions` table.
export interface LoyaltyTransaction {
  id: string
  user_id: string
  points: number
  transaction_type: string
  description: string | null
  reference_id: string | null
  reference_type: string | null
  created_at: string
}

// Mirrors the `rewards` table.
export interface Reward {
  id: string
  name: string
  description: string | null
  points_cost: number
  category: string
  tier_required: LoyaltyTier
  icon: string | null
  is_active: boolean
  quantity_available: number | null
  expires_at: string | null
  created_at: string
}

// Mirrors the `achievements` table.
export interface Achievement {
  id: string
  name: string
  description: string | null
  icon: string | null
  category: string | null
  points_reward: number
  requirement_type: string | null
  requirement_value: number | null
  is_active: boolean
  created_at: string
}

/**
 * Matches the DEPLOYED `voice_rooms` table, which is not what this interface
 * used to claim. It previously declared `topic`, `host_id` and `is_active` —
 * none of which exist in the database — and omitted every column that does.
 * `getVoiceRooms()` filtered on `.eq('is_active', true)` and so returned a
 * PostgREST error ("column voice_rooms.is_active does not exist") on every call.
 *
 * `is_public` is the room's access control signal; see services/voice.ts.
 */
export interface VoiceRoom {
  id: string
  created_at: string
  name: string
  category: string | null
  emoji: string | null
  description: string | null
  /** Access gate: public rooms are open to any member, private ones require an
   *  existing voice_participants row. */
  is_public: boolean
  /** Agora SDK channel. Effectively a join credential — see services/voice.ts. */
  agora_channel_name: string | null
  participant_count?: number
}

export interface VoiceParticipant {
  id: string
  room_id: string
  user_id: string
  joined_at: string
  is_muted: boolean
  is_speaking: boolean
}

/**
 * Matches the DEPLOYED `conversations` table (Frontend migration 003).
 *
 * This previously declared `participant_ids: string[]`, which does not exist:
 * the real table is a two-column pair, `participant_1` / `participant_2`, with
 * `last_message_at` rather than `updated_at`. Every query in services/messages.ts
 * targeted the imaginary shape, so the whole messaging domain returned PostgREST
 * errors. `participants` is kept as a derived convenience field so clients have
 * one thing to read regardless of which column a user landed in.
 */
export interface Conversation {
  id: string
  created_at: string
  participant_1: string
  participant_2: string
  last_message_at: string | null
  /**
   * The deal this thread belongs to, or null for a plain DM.
   * Added by backend migration 0009 Part E — it did not exist before, which is
   * why a negotiation could not be attached to the transaction it was about.
   */
  deal_id?: string | null
  /** Derived server-side: [participant_1, participant_2]. Not a column. */
  participants: string[]
  last_message?: Message
  unread_count?: number
}

/**
 * The counterparty as shown in a conversation list.
 *
 * Deliberately NOT the full Profile: no email, no phone. A conversation index
 * needs a name and a face; contact details are a separate disclosure decision.
 */
export interface ConversationCounterparty {
  id: string
  full_name: string | null
  company_name: string | null
  avatar_url: string | null
}

/**
 * A row of GET /api/messages/conversations.
 *
 * Distinct from `Conversation` because it is a projection, not the table: it
 * carries the genuine last message, the caller's per-conversation unread count
 * and the counterparty, all resolved by the `conversation_list()` RPC in one
 * call. The previous implementation returned a `last_message` that was actually
 * the entire message history of every conversation (a PostgREST embed returns
 * the whole child collection), so clients could not rely on it and had no unread
 * count at all beyond the platform-wide total.
 */
export interface ConversationSummary {
  id: string
  created_at: string
  participant_1: string
  participant_2: string
  participants: string[]
  deal_id: string | null
  last_message_at: string | null
  /** Messages in THIS conversation, not sent by the caller, still unread. */
  unread_count: number
  /** Null if the counterparty's profile row has been deleted. */
  counterparty: ConversationCounterparty | null
  /** Null for a conversation with no messages yet. Genuinely the newest one. */
  last_message: Pick<Message, 'id' | 'conversation_id' | 'content' | 'sender_id' | 'created_at'> | null
}

/**
 * A line of the platform-wide chat room (`global_messages`).
 *
 * Separate from `Message`: the table has no conversation_id and no `read` flag —
 * global chat has no per-user read state.
 */
export interface GlobalMessage {
  id: string
  sender_id: string
  content: string
  created_at: string
  /** Embedded profile projection; no contact details. */
  sender?: ConversationCounterparty | null
}

export interface Message {
  id: string
  conversation_id?: string
  room_id?: string
  created_at: string
  sender_id: string
  content: string
  /** Deployed column is `read`, not `is_read`. */
  read?: boolean
}

export interface NotificationPreferences {
  user_id: string
  // Email
  deal_updates: boolean
  new_messages: boolean
  price_alerts: boolean
  weekly_digest: boolean
  marketing: boolean
  // Push
  desktop: boolean
  sound: boolean
  do_not_disturb: boolean
  // Quiet hours (HH:00, 24h)
  quiet_hours_enabled: boolean
  quiet_hours_start: string
  quiet_hours_end: string
  updated_at: string
}

export interface ApiError {
  statusCode: number
  error: string
  message: string
}
