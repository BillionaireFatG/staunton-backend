/**
 * Regression guard: services/profiles.ts upsertProfile must NOT re-introduce the
 * NOT-NULL email 500.
 *
 * OFFLINE. Reads the service source off disk; makes no network calls (the live,
 * end-to-end proof that a profile edit no longer 500s lives in
 * `npm run verify:profiles`, which needs the database).
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 * upsertProfile built its patch without `email`, then called `.upsert()`.
 * supabase-js `.upsert()` compiles to INSERT ... ON CONFLICT (id) DO UPDATE, and
 * Postgres enforces NOT NULL on the tuple built for the INSERT arbiter before the
 * conflict is resolved. profiles.email is NOT NULL with no default, so any edit
 * for a user whose row did not already exist 500'd. The fix is an UPDATE keyed on
 * the id (the row is created at sign-up), with a 404 when it is genuinely absent.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const SRC = readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'profiles.ts'), 'utf8')

// Isolate the upsertProfile function body so we do not match other functions
// (uploadAvatar/removeAvatar/requestVerification all touch profiles too).
function upsertProfileBody(): string {
  const start = SRC.indexOf('export async function upsertProfile')
  assert.ok(start >= 0, 'could not find upsertProfile in services/profiles.ts')
  const next = SRC.indexOf('\nexport async function', start + 1)
  return SRC.slice(start, next === -1 ? undefined : next)
}

describe('upsertProfile does not reintroduce the NOT-NULL email 500', () => {
  const body = upsertProfileBody()

  test('it performs an UPDATE keyed on the user id, not an upsert', () => {
    assert.match(body, /\.update\(/, 'upsertProfile no longer calls .update() — it must UPDATE the existing row')
    assert.match(body, /\.eq\(\s*['"]id['"]/, 'upsertProfile must key the UPDATE on .eq("id", userId)')
  })

  test('it does NOT call .upsert() (the INSERT path that omits the NOT NULL email)', () => {
    assert.ok(
      !/\.upsert\(/.test(body),
      'upsertProfile calls .upsert() again — that INSERTs a row without the NOT NULL email and 500s',
    )
  })

  test('a missing row surfaces as a 404 rather than a null success', () => {
    assert.match(body, /statusCode:\s*404/, 'upsertProfile must 404 when the profile row is absent')
  })

  test('privileged/trust columns are never written here', () => {
    for (const col of ['is_admin', 'verification_status', 'verified_at', 'member_status', 'member_tier', 'trust_score']) {
      assert.ok(
        !new RegExp(`update\\.${col}\\b`).test(body),
        `upsertProfile writes a privileged column (${col}) — it must stay service-role/admin only`,
      )
    }
  })
})
