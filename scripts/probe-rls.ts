/**
 * TEMPORARY live-database probe for the messaging RLS audit.
 *
 * Two things are established here that cannot be established by reading the
 * migration files, because `002_messages_schema.sql` and
 * `003_profiles_and_chat.sql` define INCOMPATIBLE `messages` tables and both use
 * CREATE TABLE IF NOT EXISTS — so which one won is a question about the database,
 * not about the repo:
 *
 *   1. WHICH OBJECTS ACTUALLY EXIST. Probed with a real SELECT that returns a
 *      body. A HEAD + count request against a missing table comes back with a
 *      NULL count and no error, which is how this project previously convinced
 *      itself a missing table was present.
 *
 *   2. WHAT THE `anon` ROLE CAN READ. The anon key ships in the browser bundle,
 *      so anything anon can read is public. This is the only way to test finding
 *      F-8 for real; pg_policies is not reachable over PostgREST.
 */
import 'dotenv/config'

const URL_ = process.env.SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ANON = process.env.PROBE_ANON_KEY ?? ''

type Verdict = { target: string; status: number; verdict: string; detail: string }

async function rest(path: string, key: string, init: RequestInit = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

/** Real SELECT with a body. Distinguishes "table missing" from "table empty". */
async function tableExists(table: string, key: string): Promise<Verdict> {
  const { status, body } = await rest(`${table}?select=*&limit=1`, key)
  if (status === 200) {
    return { target: table, status, verdict: 'EXISTS', detail: `${Array.isArray(body) ? body.length : '?'} row(s) returned` }
  }
  const code = body?.code ?? ''
  if (code === '42P01') return { target: table, status, verdict: 'MISSING', detail: body?.message ?? '' }
  return { target: table, status, verdict: 'DENIED/ERROR', detail: `${code} ${body?.message ?? ''}` }
}

async function fnExists(name: string, args: Record<string, unknown>, key: string): Promise<Verdict> {
  const { status, body } = await rest(`rpc/${name}`, key, { method: 'POST', body: JSON.stringify(args) })
  if (status === 404 && body?.code === 'PGRST202') {
    return { target: name, status, verdict: 'MISSING', detail: 'no such function in schema cache' }
  }
  if (status >= 200 && status < 300) return { target: name, status, verdict: 'EXISTS + CALLABLE', detail: JSON.stringify(body).slice(0, 120) }
  return { target: name, status, verdict: 'PRESENT? errored', detail: `${body?.code ?? ''} ${body?.message ?? ''}`.slice(0, 160) }
}

/** For anon: 200 with rows = readable. 200 with [] under RLS = no rows visible. */
async function anonRead(table: string): Promise<Verdict> {
  const { status, body } = await rest(`${table}?select=*&limit=3`, ANON)
  if (status === 200) {
    const n = Array.isArray(body) ? body.length : -1
    return {
      target: table,
      status,
      verdict: n > 0 ? '*** ANON CAN READ ROWS ***' : 'anon reaches table, 0 rows visible',
      detail: n > 0 ? JSON.stringify(body[0]).slice(0, 200) : 'empty result (either RLS-filtered or empty table)',
    }
  }
  return { target: table, status, verdict: 'anon blocked', detail: `${body?.code ?? ''} ${body?.message ?? ''}`.slice(0, 160) }
}

function print(title: string, rows: Verdict[]) {
  console.log(`\n=== ${title} ===`)
  for (const r of rows) console.log(`  [${String(r.status).padEnd(3)}] ${r.target.padEnd(34)} ${r.verdict.padEnd(32)} ${r.detail}`)
}

async function main() {
  print('OBJECT EXISTENCE (service role)', [
    await tableExists('messages', SERVICE),
    await tableExists('conversations', SERVICE),
    await tableExists('global_messages', SERVICE),
    await tableExists('voice_rooms', SERVICE),
    await tableExists('voice_participants', SERVICE),
    await tableExists('voice_room_messages', SERVICE),
  ])

  const nil = '00000000-0000-0000-0000-000000000000'
  print('F-16 FUNCTIONS (service role)', [
    await fnExists('get_unread_message_count', { user_id: nil }, SERVICE),
    await fnExists('get_unread_count_by_partner', { user_id: nil, partner_id: nil }, SERVICE),
    await fnExists('mark_conversation_as_read', { user_id: nil, partner_id: nil }, SERVICE),
    await fnExists('get_room_messages', { p_room_id: nil, p_limit: 1 }, SERVICE),
  ])

  if (!ANON) {
    console.log('\n=== F-8 ANON READABILITY: SKIPPED (set PROBE_ANON_KEY) ===')
    return
  }
  print('F-8 ANON READABILITY (browser-shipped anon key)', [
    await anonRead('global_messages'),
    await anonRead('messages'),
    await anonRead('conversations'),
    await anonRead('voice_rooms'),
    await anonRead('voice_participants'),
    await anonRead('profiles'),
  ])
}

main().catch((e) => { console.error(e); process.exit(1) })
