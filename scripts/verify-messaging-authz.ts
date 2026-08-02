/**
 * Adversarial verification for migrations/0009_messaging_authz_hardening.sql.
 *
 *   npm run verify:messaging
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Migration 0005 shipped INERT. It ran without error, printed a success notice,
 * and changed nothing — the single most severe finding in the audit was "closed"
 * by a no-op for weeks. The only reason anyone found out is that someone later
 * attempted the exploit for real.
 *
 * So "the migration applied cleanly" is explicitly not the standard here. This
 * script ATTEMPTS EACH EXPLOIT with a real, logged-in, non-privileged user token
 * (and with the browser-shipped publishable key), and separately confirms that
 * the legitimate operations those locks could plausibly break still work.
 *
 * ── IT IS MEANINGFUL BEFORE *AND* AFTER THE MIGRATION ───────────────────────
 * It detects whether 0009 is applied (conversations.deal_id + conversation_list)
 * and flips its expectations accordingly:
 *
 *   BEFORE — every exploit is expected to SUCCEED. A clean run here is the
 *            reproduction: it proves the holes are real and that this harness
 *            can actually see them. A harness that passes before the fix is
 *            measuring nothing, which is how 0005 got through.
 *   AFTER  — every exploit is expected to be DENIED, and every legitimate
 *            operation is expected to still work.
 *
 * Run it BEFORE applying 0009 and keep the output. Run it again AFTER. The pair
 * of runs is the evidence; either run alone is not.
 *
 * ── REQUIREMENTS ────────────────────────────────────────────────────────────
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (already required by the server)
 *   PROBE_ANON_KEY                            the publishable/anon key
 *
 * PROBE_ANON_KEY is not a secret — it is the key that ships inside the browser
 * bundle, which is precisely why what it can reach is a security question.
 *
 * DEV ONLY. Refuses to run with NODE_ENV=production. It creates two throwaway
 * auth users plus their profiles, a conversation and a few messages, and removes
 * all of it again on the way out, including on failure.
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const URL_ = process.env.SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON = process.env.PROBE_ANON_KEY

if (!URL_ || !SERVICE) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
if (!ANON) {
  throw new Error(
    'Missing PROBE_ANON_KEY. This harness cannot do its job without it: the whole ' +
      'question is what a browser-shipped key can reach. Copy NEXT_PUBLIC_SUPABASE_ANON_KEY ' +
      'from Frontend/.env.local.',
  )
}

const sb = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

let failures = 0
const pass = (m: string) => console.log(`  PASS  ${m}`)
const fail = (m: string) => {
  failures++
  console.log(`  FAIL  ${m}`)
}

// ── Raw PostgREST, so we control exactly which identity is presented ────────
// The supabase-js client is deliberately not used for the attack calls: it
// layers retries and error shaping over the response, and here the raw status
// and SQLSTATE are the finding.
async function rest(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON!, // the anon key is the API key even for a user session
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const isDenied = (r: { status: number; body: any }) =>
  r.status === 401 ||
  r.status === 403 ||
  r.body?.code === '42501' ||
  r.body?.code === 'PGRST202' ||
  r.body?.code === 'PGRST301' ||
  /permission denied/i.test(String(r.body?.message ?? ''))

const describe = (r: { status: number; body: any }) =>
  `${r.status} ${r.body?.code ?? ''} ${String(r.body?.message ?? JSON.stringify(r.body ?? '')).slice(0, 110)}`

/**
 * One adversarial assertion.
 *
 * `mustBeDenied` is the post-migration expectation. Pre-migration the same call
 * is expected to SUCCEED, and a denial there means the reproduction is not
 * reproducing — reported as a failure rather than quietly celebrated.
 */
function expectExploit(label: string, r: { status: number; body: any }, applied: boolean) {
  const denied = isDenied(r)
  if (applied) {
    if (denied) pass(`[blocked] ${label} -> ${describe(r)}`)
    else fail(`[EXPLOITABLE] ${label} -> NOT blocked: ${describe(r)}`)
  } else {
    if (denied)
      fail(
        `[no repro] ${label} -> already denied before 0009 (${describe(r)}). ` +
          `Either the hole is not what was described or this check is aimed at the wrong thing. ` +
          `Investigate rather than assume you are safe.`,
      )
    else pass(`[reproduced, as expected pre-0009] ${label} -> ${describe(r)}`)
  }
}

/** An operation that must keep working in BOTH states. The regression half. */
function expectLegit(label: string, ok: boolean, detail: string) {
  if (ok) pass(`[still works] ${label}`)
  else fail(`[BROKE SOMETHING LEGITIMATE] ${label} -> ${detail}`)
}

// ── Is 0009 applied? ────────────────────────────────────────────────────────
// Asked of the database, not of a file or a changelog. Two independent markers
// so a partial application is visible rather than rounded to "applied".
async function detectApplied(): Promise<boolean> {
  const spec: any = await fetch(`${URL_}/rest/v1/`, {
    headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, Accept: 'application/openapi+json' },
  }).then((r) => r.json())

  const hasDealId = Boolean(spec?.definitions?.conversations?.properties?.deal_id)
  const hasRpc = Object.keys(spec?.paths ?? {}).includes('/rpc/conversation_list')
  const hasVrm = Boolean(spec?.definitions?.voice_room_messages)

  console.log('\n=== STATE DETECTION ===')
  console.log(`  conversations.deal_id present : ${hasDealId}`)
  console.log(`  conversation_list RPC present : ${hasRpc}`)
  console.log(`  voice_room_messages present   : ${hasVrm}`)

  if (hasDealId && hasRpc && hasVrm) {
    console.log('  => 0009 APPLIED. Expecting every exploit to be blocked.')
    return true
  }
  if (!hasDealId && !hasRpc && !hasVrm) {
    console.log('  => 0009 NOT APPLIED. Expecting every exploit to reproduce.')
    return false
  }
  console.log(
    '  => *** PARTIALLY APPLIED *** — some markers present, some absent. 0009 is one file and ' +
      'should be all-or-nothing; a partial state means it errored midway. Treating as APPLIED ' +
      'so the exploit checks are strict, but resolve this first.',
  )
  return true
}

// ── Throwaway identities ────────────────────────────────────────────────────
interface TestUser {
  id: string
  email: string
  token: string
}

const created: string[] = []

async function makeUser(tag: string): Promise<TestUser> {
  const email = `verify-msg-${tag}-${randomUUID()}@staunton-verify.invalid`
  const password = `Vf!${randomUUID()}`

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user) throw new Error(`createUser(${tag}) failed: ${error?.message}`)
  created.push(data.user.id)

  // messages.sender_id and conversations.participant_* are FKs to profiles, so a
  // profile row must exist. Upserted with the service role because 0010 removed
  // the client INSERT privilege on the locked columns.
  const { error: pErr } = await sb
    .from('profiles')
    .upsert({ id: data.user.id, email, full_name: `Verify ${tag}` }, { onConflict: 'id' })
  if (pErr) throw new Error(`profile upsert(${tag}) failed: ${pErr.message}`)

  // A REAL session, obtained the way the browser obtains one.
  const anonClient = createClient(URL_!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: session, error: sErr } = await anonClient.auth.signInWithPassword({ email, password })
  if (sErr || !session.session) throw new Error(`signIn(${tag}) failed: ${sErr?.message}`)

  return { id: data.user.id, email, token: session.session.access_token }
}

async function cleanup(convId?: string) {
  if (convId) {
    await sb.from('messages').delete().eq('conversation_id', convId)
    await sb.from('conversations').delete().eq('id', convId)
  }
  for (const id of created) {
    await sb.from('global_messages').delete().eq('sender_id', id)
    await sb.from('profiles').delete().eq('id', id)
    await sb.auth.admin.deleteUser(id).catch(() => {})
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run against production')

  const applied = await detectApplied()
  let convId: string | undefined

  try {
    const alice = await makeUser('alice')
    const bob = await makeUser('bob')

    // A conversation between them, with one message from each.
    const [p1, p2] = alice.id < bob.id ? [alice.id, bob.id] : [bob.id, alice.id]
    const { data: conv, error: cErr } = await sb
      .from('conversations')
      .insert({ participant_1: p1, participant_2: p2 })
      .select('id')
      .single()
    if (cErr) throw new Error(`conversation insert failed: ${cErr.message}`)
    convId = conv.id

    const { data: aliceMsg, error: mErr } = await sb
      .from('messages')
      .insert({ conversation_id: convId, sender_id: alice.id, content: 'ORIGINAL: offer 500t at 973.25', read: false })
      .select('id, content')
      .single()
    if (mErr) throw new Error(`message insert failed: ${mErr.message}`)

    // ── F-7: message content forgery ────────────────────────────────────────
    // Bob is a legitimate participant, so 003's UPDATE policy (USING only, no
    // WITH CHECK) lets him through on the ROW. The question is whether it also
    // lets him through on the COLUMN. This is the negotiation-record integrity
    // finding: if it succeeds, a counterparty can retroactively rewrite what you
    // offered.
    console.log('\n=== F-7: CAN A COUNTERPARTY REWRITE YOUR MESSAGE? (real user token) ===')

    const forge = await rest(`messages?id=eq.${aliceMsg.id}`, bob.token, {
      method: 'PATCH',
      body: JSON.stringify({ content: 'FORGED: offer 500t at 200.00' }),
      headers: { Prefer: 'return=representation' },
    })
    expectExploit("Bob rewrites Alice's message content", forge, applied)

    const reattribute = await rest(`messages?id=eq.${aliceMsg.id}`, bob.token, {
      method: 'PATCH',
      body: JSON.stringify({ sender_id: bob.id }),
      headers: { Prefer: 'return=representation' },
    })
    expectExploit("Bob reattributes Alice's message to himself", reattribute, applied)

    // Independent of what PostgREST reported: read the row back with the service
    // role and check the text on disk. A 200 with zero rows affected is not a
    // successful exploit, and a denial that nonetheless mutated the row would be
    // far worse than either.
    const { data: after } = await sb.from('messages').select('content, sender_id').eq('id', aliceMsg.id).single()
    const intact = after?.content === aliceMsg.content && after?.sender_id === alice.id
    if (applied) {
      if (intact) pass('[ground truth] message row is byte-identical after both attempts')
      else fail(`[ground truth] MESSAGE WAS MUTATED despite the API response: ${JSON.stringify(after)}`)
    } else {
      console.log(`  INFO  ground truth after attempts: ${JSON.stringify(after)}`)
    }

    // Restore, so the legitimate-write check below is not confounded.
    await sb
      .from('messages')
      .update({ content: aliceMsg.content, sender_id: alice.id, read: false })
      .eq('id', aliceMsg.id)

    // ── The other half: the lock must not break the app ─────────────────────
    // 0009 leaves exactly one client write path on messages: the recipient
    // flipping `read`. That is what the frontend's markAsRead does. If this
    // fails, the migration is a regression and would be reverted — which is how
    // a fix gets undone and a hole silently reopens.
    console.log('\n=== REGRESSION: THE ONE LEGITIMATE CLIENT WRITE ===')
    const markRead = await rest(
      `messages?conversation_id=eq.${convId}&sender_id=neq.${bob.id}`,
      bob.token,
      { method: 'PATCH', body: JSON.stringify({ read: true }), headers: { Prefer: 'return=representation' } },
    )
    expectLegit(
      'recipient marks received messages read (frontend markAsRead)',
      markRead.status >= 200 && markRead.status < 300,
      describe(markRead),
    )
    const { data: readBack } = await sb.from('messages').select('read').eq('id', aliceMsg.id).single()
    expectLegit('…and the read flag actually persisted', readBack?.read === true, JSON.stringify(readBack))

    // ── Baseline: a stranger must see nothing ───────────────────────────────
    // Not a 0009 fix — a control. If this ever fails, the problem is bigger than
    // this migration.
    console.log('\n=== CONTROL: A NON-PARTICIPANT ===')
    const carol = await makeUser('carol')
    const peek = await rest(`messages?conversation_id=eq.${convId}&select=content`, carol.token)
    const leaked = Array.isArray(peek.body) && peek.body.length > 0
    expectLegit(
      'non-participant reads zero messages from a conversation they are not in',
      !leaked,
      describe(peek),
    )

    // ── F-8: the browser-shipped key ────────────────────────────────────────
    console.log('\n=== F-8: WHAT THE ANON KEY CAN READ (invite-only platform) ===')

    // Seed one global message so "0 rows" cannot be mistaken for "blocked".
    const { error: gErr } = await sb
      .from('global_messages')
      .insert({ sender_id: alice.id, content: 'verify-messaging canary' })
    if (gErr) console.log(`  WARN  could not seed global_messages canary: ${gErr.message}`)

    for (const table of ['global_messages', 'voice_rooms', 'messages', 'conversations', 'voice_participants']) {
      const r = await rest(`${table}?select=*&limit=3`, ANON!)
      const rows = Array.isArray(r.body) ? r.body.length : 0
      if (applied) {
        expectExploit(`anon reads ${table}`, r, true)
      } else if (rows > 0) {
        pass(`[reproduced, as expected pre-0009] anon reads ${table} -> ${rows} row(s) returned`)
      } else {
        // 200 with [] is ambiguous: RLS-filtered, or simply an empty table.
        // Reported as information, never as a pass.
        console.log(`  INFO  anon reaches ${table}, 0 rows visible (RLS-filtered or empty) -> ${describe(r)}`)
      }
    }

    // agora_channel_name is the sharpest part of F-8: this backend mints no
    // Agora token, so the channel name is the closest thing to a join credential
    // that exists.
    const rooms = await rest('voice_rooms?select=agora_channel_name&limit=1', ANON!)
    if (applied) expectExploit('anon reads voice_rooms.agora_channel_name (join credential)', rooms, true)
    else if (Array.isArray(rooms.body) && rooms.body.length > 0)
      pass(`[reproduced, as expected pre-0009] anon reads agora_channel_name -> ${JSON.stringify(rooms.body[0])}`)

    // ── F-16 / Part G: SECURITY DEFINER functions with a user_id argument ────
    console.log('\n=== SECURITY DEFINER FUNCTIONS TAKING A CALLER-SUPPLIED user_id ===')

    // conversation_list is introduced BY 0009 and is the same dangerous shape as
    // the functions Part C drops, so it is held to the same rule: service_role
    // only. If a client can call it, 0009 has closed one hole and opened another.
    const cl = await rest('rpc/conversation_list', bob.token, {
      method: 'POST',
      body: JSON.stringify({ p_user: alice.id, p_limit: 50 }),
    })
    if (applied) {
      if (isDenied(cl)) pass(`[blocked] authenticated user calls conversation_list(p_user=<someone else>) -> ${describe(cl)}`)
      else fail(`[EXPLOITABLE] conversation_list is client-callable — reads any user's inbox: ${describe(cl)}`)
    } else {
      console.log(`  INFO  conversation_list not present yet -> ${describe(cl)}`)
    }
    const clAnon = await rest('rpc/conversation_list', ANON!, {
      method: 'POST',
      body: JSON.stringify({ p_user: alice.id, p_limit: 50 }),
    })
    if (applied) {
      if (isDenied(clAnon)) pass(`[blocked] anon calls conversation_list -> ${describe(clAnon)}`)
      else fail(`[EXPLOITABLE] anon can call conversation_list: ${describe(clAnon)}`)
    }

    for (const fn of ['get_unread_message_count', 'get_unread_count_by_partner', 'mark_conversation_as_read']) {
      const r = await rest(`rpc/${fn}`, bob.token, {
        method: 'POST',
        body: JSON.stringify({ user_id: alice.id, partner_id: bob.id }),
      })
      const gone = r.status === 404 && r.body?.code === 'PGRST202'
      if (gone) pass(`${fn} is absent (F-16 not reachable)`)
      else if (isDenied(r)) pass(`${fn} present but denied to clients -> ${describe(r)}`)
      else fail(`[EXPLOITABLE] ${fn} is client-callable with an arbitrary user_id -> ${describe(r)}`)
    }

    // Maintenance routines default to EXECUTE TO PUBLIC, which makes them
    // callable PostgREST endpoints for anyone holding the browser key.
    // cleanup_old_global_messages truncates chat history.
    for (const fn of ['cleanup_old_global_messages', 'cleanup_stale_participants']) {
      const r = await rest(`rpc/${fn}`, ANON!, { method: 'POST', body: '{}' })
      const gone = r.status === 404 && r.body?.code === 'PGRST202'
      if (applied) {
        if (isDenied(r) || gone) pass(`[blocked] anon calls maintenance routine ${fn} -> ${describe(r)}`)
        else fail(`[EXPLOITABLE] anon can invoke ${fn} (history truncation) -> ${describe(r)}`)
      } else if (!isDenied(r) && !gone) {
        pass(`[reproduced, as expected pre-0009] anon can invoke ${fn} -> ${describe(r)}`)
      }
    }

    // ── Part D: voice_room_messages must be backend-only ────────────────────
    if (applied) {
      console.log('\n=== PART D: voice_room_messages IS BACKEND-ONLY ===')
      const { data: vrm, error: vErr } = await sb.from('voice_room_messages').select('sender_id').limit(1)
      expectLegit(
        'service role can read voice_room_messages (so the API works)',
        !vErr,
        vErr?.message ?? '',
      )
      if (!vErr && vrm) pass('…and it has a sender_id column, so services/voice.ts matches the schema')

      for (const tok of [bob.token, ANON!]) {
        const r = await rest('voice_room_messages?select=*&limit=1', tok)
        expectExploit(
          `${tok === ANON ? 'anon' : 'authenticated user'} reads voice_room_messages directly`,
          r,
          true,
        )
      }
    }

    // ── Part E: deal threads ────────────────────────────────────────────────
    if (applied) {
      console.log('\n=== PART E: PER-DEAL THREADS ===')
      const { error: dErr } = await sb
        .from('conversations')
        .update({ deal_id: null })
        .eq('id', convId)
      expectLegit('conversations.deal_id exists and is nullable (plain DMs still valid)', !dErr, dErr?.message ?? '')
    }
  } finally {
    await cleanup(convId)
  }

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ` +
      `(state: 0009 ${applied ? 'APPLIED' : 'NOT applied'})`,
  )
  if (!applied) {
    console.log(
      '\nThis was the BEFORE run. Apply migrations/0009_messaging_authz_hardening.sql in the\n' +
        'Supabase SQL editor, then run this again — the AFTER run is what demonstrates the fix.',
    )
  }
  // exitCode rather than process.exit(): an abrupt exit while the Supabase
  // client still holds handles trips a libuv assertion on Windows, which would
  // mask the real exit status this script exists to report.
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  cleanup().finally(() => {
    process.exitCode = 1
  })
})
