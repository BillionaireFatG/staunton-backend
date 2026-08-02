import { supabase } from '../lib/supabase'
import { Deal, DealEvent } from '../types'

// Column names below are verified against the LIVE database (2026-08-01), not
// against the migration files — those had drifted. The live `deals` table uses
// commodity_type / unit_price / delivery_location, and `deal_events` uses
// event_type / description / metadata.

export const COMMODITY_TYPES = [
  'fuel_diesel',
  'fuel_gasoline',
  'fuel_jet',
  'fuel_crude',
  'metal_copper',
  'metal_aluminum',
  'metal_zinc',
  'agriculture_grain',
  'agriculture_oil',
  'chemical_industrial',
] as const
export type CommodityType = (typeof COMMODITY_TYPES)[number]

export const DEAL_STATUSES = [
  'draft',
  'pending',
  'active',
  'injecting',
  'inspection',
  'completed',
  'cancelled',
  'disputed',
] as const
export type DealStatusValue = (typeof DEAL_STATUSES)[number]

/** Server-side hard cap. Clients may request fewer, never more. */
const MAX_PAGE_SIZE = 50
const DEFAULT_PAGE_SIZE = 20
const MAX_EVENT_PAGE_SIZE = 100
const MIN_SEARCH_LENGTH = 2

function clampLimit(requested: number | undefined, max: number, fallback: number): number {
  if (!Number.isFinite(requested)) return fallback
  return Math.min(Math.max(Math.trunc(requested as number), 1), max)
}

export async function createDeal(data: {
  buyer_id: string
  seller_id: string
  commodity_type: CommodityType
  quantity: number
  unit_price: number
  delivery_location: string
  created_by: string
  notes?: string
}): Promise<Deal> {
  if (!(data.quantity > 0)) throw Object.assign(new Error('Quantity must be greater than 0'), { statusCode: 400 })
  if (!(data.unit_price > 0)) throw Object.assign(new Error('Unit price must be greater than 0'), { statusCode: 400 })
  if (!data.delivery_location) throw Object.assign(new Error('Delivery location is required'), { statusCode: 400 })
  if (!data.buyer_id || !data.seller_id) throw Object.assign(new Error('Buyer and seller are required'), { statusCode: 400 })
  if (data.buyer_id === data.seller_id) {
    throw Object.assign(new Error('Buyer and seller must be different parties'), { statusCode: 400 })
  }
  if (!COMMODITY_TYPES.includes(data.commodity_type)) {
    throw Object.assign(new Error('Unknown commodity type'), { statusCode: 400 })
  }

  // Explicit field list, never a spread of the request body: the caller must not
  // be able to set status, total_value, reference_number or progress_percentage.
  const { data: deal, error } = await supabase
    .from('deals')
    .insert({
      buyer_id: data.buyer_id,
      seller_id: data.seller_id,
      commodity_type: data.commodity_type,
      quantity: data.quantity,
      unit_price: data.unit_price,
      delivery_location: data.delivery_location,
      notes: data.notes ?? null,
      created_by: data.created_by,
      status: 'draft',
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return deal
}

export async function getDeals(
  userId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<Deal[]> {
  // Previously unbounded — a single call returned every deal the user could see.
  const limit = clampLimit(opts.limit, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)

  let q = supabase
    .from('deals')
    .select('*')
    .or(`buyer_id.eq.${userId},seller_id.eq.${userId},broker_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(limit)

  // Keyset pagination rather than offset: stable under inserts, and no deep-offset scan.
  if (opts.before) q = q.lt('created_at', opts.before)

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getDeal(id: string, userId: string): Promise<Deal> {
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .eq('id', id)
    .or(`buyer_id.eq.${userId},seller_id.eq.${userId},broker_id.eq.${userId}`)
    .single()

  // 404 rather than 403 for a non-party: a 403 would confirm the id exists.
  if (error || !data) throw Object.assign(new Error('Deal not found'), { statusCode: 404 })
  return data
}

/**
 * Only `status` and `notes` are patchable. The previous implementation spread
 * the raw request body into the update, and the route passed `req.body as any`
 * — so a party could rewrite unit_price, quantity, total_value, seller_id,
 * reference_number or progress_percentage. progress_percentage in particular is
 * what a lender reads to release funds; it must never be client-writable.
 */
export async function updateDeal(
  id: string,
  userId: string,
  patch: { status?: DealStatusValue; notes?: string },
): Promise<Deal> {
  await getDeal(id, userId) // access check

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (patch.status !== undefined) {
    if (!DEAL_STATUSES.includes(patch.status)) {
      throw Object.assign(new Error('Unknown deal status'), { statusCode: 400 })
    }
    update.status = patch.status
  }
  if (patch.notes !== undefined) update.notes = patch.notes

  if (Object.keys(update).length === 1) {
    throw Object.assign(new Error('No updatable fields supplied'), { statusCode: 400 })
  }

  const { data, error } = await supabase
    .from('deals')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function createDealEvent(
  dealId: string,
  userId: string,
  eventType: string,
  description: string,
  metadata: Record<string, unknown> = {},
): Promise<DealEvent> {
  await getDeal(dealId, userId)

  if (!eventType) throw Object.assign(new Error('event_type is required'), { statusCode: 400 })
  if (!description) throw Object.assign(new Error('description is required'), { statusCode: 400 })

  const { data, error } = await supabase
    .from('deal_events')
    .insert({
      deal_id: dealId,
      event_type: eventType,
      description,
      metadata,
      created_by: userId,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function getDealEvents(
  dealId: string,
  userId: string,
  opts: { limit?: number } = {},
): Promise<DealEvent[]> {
  await getDeal(dealId, userId)
  const limit = clampLimit(opts.limit, MAX_EVENT_PAGE_SIZE, MAX_EVENT_PAGE_SIZE)

  const { data, error } = await supabase
    .from('deal_events')
    .select('*')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error) throw new Error(error.message)
  return data ?? []
}

/**
 * Counterparty lookup. Three prior defects fixed:
 *  - selected trust_score / is_verified / roles, none of which exist on the
 *    live profiles table (they are verification_status and role)
 *  - an empty query matched every profile, dumping the member directory
 *  - the limit was fixed at 20 but the column list was `*`-adjacent
 * Contact details (email, phone) are deliberately NOT returned.
 */
export async function searchCounterparties(query: string, excludeId: string) {
  const trimmed = (query ?? '').trim()
  if (trimmed.length < MIN_SEARCH_LENGTH) {
    throw Object.assign(
      new Error(`Search query must be at least ${MIN_SEARCH_LENGTH} characters`),
      { statusCode: 400 },
    )
  }

  // Escape PostgREST pattern metacharacters so a query of '%' cannot match all.
  const pattern = `%${trimmed.replace(/[%_\\]/g, (c) => `\\${c}`)}%`

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, company_name, avatar_url, verification_status, role')
    .neq('id', excludeId)
    .or(`full_name.ilike.${pattern},company_name.ilike.${pattern}`)
    .limit(20)

  if (error) throw new Error(error.message)
  return data ?? []
}
