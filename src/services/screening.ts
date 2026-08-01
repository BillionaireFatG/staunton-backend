// ============================================================================
// screening.ts — Sanctions/PEP screening via OpenSanctions + blacklist re-entry
// ============================================================================
// Discipline (non-negotiable, per the handoff):
//   • Always store the RAW provider response in screening_results.
//   • Always write a verification_checks row with status 'pending'.
//   • NEVER auto-pass or auto-fail. A human reviews every match in the queue.
//
// OpenSanctions hosted API needs OPENSANCTIONS_API_KEY. If it's absent the
// screening degrades gracefully: we still record a pending screening_results
// row + a pending check so the reviewer knows to screen manually. It never
// blocks submission.
// ============================================================================

import { supabase } from '../lib/supabase'
import type { BeneficialOwner } from '../types/vetting'

const OS_ENDPOINT = 'https://api.opensanctions.org/match/default'
const OS_API_KEY = process.env.OPENSANCTIONS_API_KEY

// ── 24h cache + simple rate limiter ─────────────────────────────────────────
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const cache = new Map<string, { at: number; data: OsMatchResult }>()

// Serialize outbound calls with a minimum spacing so we never hammer the API.
const MIN_INTERVAL_MS = 250
let rateChain: Promise<void> = Promise.resolve()
function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
  const run = rateChain.then(fn)
  rateChain = run.then(
    () => new Promise((r) => setTimeout(r, MIN_INTERVAL_MS)),
    () => new Promise((r) => setTimeout(r, MIN_INTERVAL_MS)),
  )
  return run
}

interface OsMatchResult {
  matchCount: number
  highestScore: number | null
  raw: unknown
  query: unknown
  degraded: boolean // true when we could not actually reach the provider
}

type Schema = 'Person' | 'Company' | 'LegalEntity'

interface OsProps {
  name: string
  birthDate?: string
  nationality?: string
}

async function callOpenSanctions(schema: Schema, props: OsProps): Promise<OsMatchResult> {
  const properties: Record<string, string[]> = { name: [props.name] }
  if (props.birthDate) properties.birthDate = [props.birthDate]
  if (props.nationality) properties.nationality = [props.nationality]

  const query = { queries: { q1: { schema, properties } } }

  if (!OS_API_KEY) {
    // No key configured — degrade, do not fabricate a result.
    return { matchCount: 0, highestScore: null, raw: null, query, degraded: true }
  }

  const cacheKey = `${schema}:${props.name}:${props.birthDate ?? ''}:${props.nationality ?? ''}`.toLowerCase()
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data

  const data = await rateLimited(async () => {
    const res = await fetch(OS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${OS_API_KEY}`,
      },
      body: JSON.stringify(query),
    })
    if (!res.ok) {
      throw Object.assign(new Error(`OpenSanctions ${res.status}`), { statusCode: 502 })
    }
    const body: any = await res.json()
    const results: any[] = body?.responses?.q1?.results ?? []
    const highest = results.reduce<number | null>(
      (m, r) => (typeof r.score === 'number' ? Math.max(m ?? 0, r.score) : m),
      null,
    )
    const result: OsMatchResult = {
      matchCount: results.length,
      highestScore: highest,
      raw: body,
      query,
      degraded: false,
    }
    return result
  })

  cache.set(cacheKey, { at: Date.now(), data })
  return data
}

/**
 * Screen one subject (org entity or a beneficial owner), recording the raw
 * response and a pending verification check. Returns the screening_results id.
 */
async function screenSubject(params: {
  subjectType: 'org' | 'owner'
  subjectId: string
  schema: Schema
  props: OsProps
  checkType: 'sanctions_screening'
}): Promise<string> {
  let result: OsMatchResult
  try {
    result = await callOpenSanctions(params.schema, params.props)
  } catch (err: any) {
    // Provider error: record a degraded pending screening rather than failing submission.
    result = { matchCount: 0, highestScore: null, raw: { error: String(err?.message ?? err) }, query: null, degraded: true }
  }

  const { data: sr, error: srErr } = await supabase
    .from('screening_results')
    .insert({
      subject_type: params.subjectType,
      subject_id: params.subjectId,
      provider: 'opensanctions',
      query_payload: result.query as any,
      raw_response: result.raw as any,
      match_count: result.matchCount,
      highest_score: result.highestScore,
      review_outcome: 'pending',
    })
    .select('id')
    .single()

  if (srErr) throw new Error(srErr.message)

  // Always a PENDING check — the human reviews it. Never auto-decided here.
  await supabase.from('verification_checks').insert({
    subject_type: params.subjectType,
    subject_id: params.subjectId,
    check_type: params.checkType,
    status: 'pending',
    method: result.degraded ? 'manual_registry_lookup' : 'opensanctions_api',
    notes: result.degraded
      ? 'Automated screening unavailable — screen manually.'
      : `Automated screening returned ${result.matchCount} candidate match(es); review required.`,
  })

  return sr.id
}

/**
 * Fire screening for an org and every beneficial owner on submission.
 */
export async function screenApplication(org: {
  id: string
  legal_name: string
  jurisdiction?: string | null
}): Promise<void> {
  // Entity screening
  await screenSubject({
    subjectType: 'org',
    subjectId: org.id,
    schema: 'Company',
    props: { name: org.legal_name },
    checkType: 'sanctions_screening',
  })

  // Owner screening (person)
  const { data: owners } = await supabase
    .from('beneficial_owners')
    .select('id, full_name, dob, nationality')
    .eq('org_id', org.id)

  for (const o of (owners ?? []) as Pick<BeneficialOwner, 'id' | 'full_name' | 'dob' | 'nationality'>[]) {
    await screenSubject({
      subjectType: 'owner',
      subjectId: o.id,
      schema: 'Person',
      props: {
        name: o.full_name,
        birthDate: o.dob ?? undefined,
        nationality: o.nationality ?? undefined,
      },
      checkType: 'sanctions_screening',
    })
  }
}

/**
 * Blacklist re-entry check: a fraudster's second attempt usually reuses a
 * person. Compare this org's beneficial owners against owners linked to any
 * blacklisted org. Any match → hard flag on the owner + a flagged check.
 */
export async function checkBlacklistReentry(orgId: string): Promise<number> {
  const { data: owners } = await supabase
    .from('beneficial_owners')
    .select('id, full_name, dob')
    .eq('org_id', orgId)

  if (!owners?.length) return 0

  // Owners belonging to blacklisted orgs (exclude this org).
  const { data: blacklisted } = await supabase
    .from('beneficial_owners')
    .select('full_name, dob, organizations!inner(status)')
    .eq('organizations.status', 'blacklisted')

  const blSet = new Set(
    (blacklisted ?? []).map((b: any) => normalizePerson(b.full_name, b.dob)),
  )

  let flags = 0
  for (const o of owners as { id: string; full_name: string; dob: string | null }[]) {
    if (blSet.has(normalizePerson(o.full_name, o.dob))) {
      flags++
      await supabase.from('beneficial_owners').update({ sanctions_flag: true }).eq('id', o.id)
      await supabase.from('verification_checks').insert({
        subject_type: 'owner',
        subject_id: o.id,
        check_type: 'blacklist_reentry',
        status: 'flagged',
        method: 'manual_registry_lookup',
        notes: 'Beneficial owner matches an owner of a blacklisted organization. Investigate before proceeding.',
      })
    }
  }
  return flags
}

function normalizePerson(name: string, dob: string | null): string {
  return `${name.trim().toLowerCase().replace(/\s+/g, ' ')}|${dob ?? ''}`
}

/**
 * Re-screen every active org (provisional/full). Someone clean in January can
 * be listed in June. Each run appends fresh screening_results + pending checks
 * for review; the admin queue's screening flag surfaces new hits. Intended to
 * run monthly (schedule an external cron / task to POST the rescreen endpoint)
 * and on deal creation.
 */
export async function rescreenActiveOrgs(): Promise<{ orgsScreened: number }> {
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, legal_name, jurisdiction, status')
    .in('status', ['provisional', 'full'])

  for (const org of (orgs ?? []) as { id: string; legal_name: string; jurisdiction: string | null }[]) {
    try {
      await screenApplication(org)
      await checkBlacklistReentry(org.id)
    } catch (e) {
      console.error(`rescreen failed for org ${org.id}:`, e)
    }
  }
  return { orgsScreened: orgs?.length ?? 0 }
}
