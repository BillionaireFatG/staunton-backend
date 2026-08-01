import { supabase } from '../lib/supabase'
import { NotificationPreferences } from '../types'

const DEFAULTS: Omit<NotificationPreferences, 'user_id' | 'updated_at'> = {
  // Email
  deal_updates: true,
  new_messages: true,
  price_alerts: true,
  weekly_digest: false,
  marketing: false,
  // Push
  desktop: true,
  sound: true,
  do_not_disturb: false,
  // Quiet hours
  quiet_hours_enabled: false,
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
}

const BOOLEAN_FIELDS = [
  'deal_updates',
  'new_messages',
  'price_alerts',
  'weekly_digest',
  'marketing',
  'desktop',
  'sound',
  'do_not_disturb',
  'quiet_hours_enabled',
] as const

const QUIET_HOUR_FIELDS = ['quiet_hours_start', 'quiet_hours_end'] as const

const HH00 = /^([01]\d|2[0-3]):00$/

export async function getPreferences(userId: string): Promise<NotificationPreferences> {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (data) return data

  // Upsert-on-read: persist a defaults row on first access.
  const { data: created, error: insertError } = await supabase
    .from('notification_preferences')
    .upsert({ user_id: userId, ...DEFAULTS, updated_at: new Date().toISOString() })
    .select()
    .single()

  if (insertError) throw new Error(insertError.message)
  return created
}

export async function updatePreferences(
  userId: string,
  patch: Record<string, unknown>
): Promise<NotificationPreferences> {
  const clean: Record<string, boolean | string> = {}

  for (const field of BOOLEAN_FIELDS) {
    if (patch[field] !== undefined) {
      if (typeof patch[field] !== 'boolean') {
        throw Object.assign(new Error(`${field} must be a boolean`), { statusCode: 400 })
      }
      clean[field] = patch[field] as boolean
    }
  }

  for (const field of QUIET_HOUR_FIELDS) {
    if (patch[field] !== undefined) {
      const value = patch[field]
      if (typeof value !== 'string' || !HH00.test(value)) {
        throw Object.assign(new Error(`${field} must match HH:00 (00:00–23:00)`), { statusCode: 400 })
      }
      clean[field] = value
    }
  }

  // Ensure the row exists (and apply defaults) before patching.
  await getPreferences(userId)

  const { data, error } = await supabase
    .from('notification_preferences')
    .upsert({ user_id: userId, ...clean, updated_at: new Date().toISOString() })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}
