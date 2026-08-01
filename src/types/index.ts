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

export interface Profile {
  id: string
  created_at: string
  full_name: string
  avatar_url?: string
  roles: string[]
  is_verified: boolean
  trust_score: number
  bio?: string
  company_name?: string | null
  phone?: string | null
  location?: string | null
  verification_status?: string
  verification_requested_at?: string | null
}

export interface LoyaltyState {
  user_id: string
  tier: LoyaltyTier
  points_earned: number
  points_redeemed: number
  points_balance: number
}

export interface LoyaltyTransaction {
  id: string
  user_id: string
  created_at: string
  type: 'earned' | 'redeemed' | 'bonus' | 'referral'
  points: number
  description: string
}

export interface Reward {
  id: string
  title: string
  description: string
  points_cost: number
  tier_required: LoyaltyTier
}

export interface Achievement {
  id: string
  title: string
  description: string
  icon: string
  points_reward: number
}

export interface VoiceRoom {
  id: string
  created_at: string
  name: string
  topic?: string
  host_id: string
  is_active: boolean
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

export interface Conversation {
  id: string
  created_at: string
  participant_ids: string[]
  last_message?: Message
  unread_count?: number
}

export interface Message {
  id: string
  conversation_id?: string
  room_id?: string
  created_at: string
  sender_id: string
  content: string
  is_read?: boolean
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
