import { supabase } from '../lib/supabase'
import { Deal, DealEvent, DealStatus } from '../types'

export async function createDeal(data: {
  buyer_id: string
  seller_id: string
  commodity: string
  quantity: number
  price: number
  location: string
  notes?: string
}): Promise<Deal> {
  if (data.quantity <= 0) throw new Error('Quantity must be greater than 0')
  if (data.price <= 0) throw new Error('Price must be greater than 0')
  if (!data.location) throw new Error('Location is required')
  if (!data.buyer_id || !data.seller_id) throw new Error('Buyer and seller are required')

  const { data: deal, error } = await supabase
    .from('deals')
    .insert({ ...data, status: 'draft' })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return deal
}

export async function getDeals(userId: string): Promise<Deal[]> {
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getDeal(id: string, userId: string): Promise<Deal> {
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .eq('id', id)
    .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
    .single()

  if (error || !data) throw Object.assign(new Error('Deal not found'), { statusCode: 404 })
  return data
}

export async function updateDeal(id: string, userId: string, patch: Partial<Pick<Deal, 'status' | 'notes'>>): Promise<Deal> {
  await getDeal(id, userId) // ensure access

  const { data, error } = await supabase
    .from('deals')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function createDealEvent(dealId: string, userId: string, type: string, payload: Record<string, unknown>): Promise<DealEvent> {
  await getDeal(dealId, userId)

  const { data, error } = await supabase
    .from('deal_events')
    .insert({ deal_id: dealId, type, payload, created_by: userId })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function getDealEvents(dealId: string, userId: string): Promise<DealEvent[]> {
  await getDeal(dealId, userId)

  const { data, error } = await supabase
    .from('deal_events')
    .select('*')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function searchCounterparties(query: string, excludeId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, avatar_url, trust_score, is_verified, roles')
    .neq('id', excludeId)
    .ilike('full_name', `%${query}%`)
    .limit(20)

  if (error) throw new Error(error.message)
  return data ?? []
}
