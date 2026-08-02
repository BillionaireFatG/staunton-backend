/**
 * Migration lint: column-level REVOKE must never stand alone.
 *
 * OFFLINE. Reads migrations/*.sql off disk; makes no network calls.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 * From the PostgreSQL REVOKE documentation:
 *
 *     "On the other hand, if a role has been granted privileges on a table,
 *      then revoking the same privileges from individual columns will have no
 *      effect."
 *
 * Supabase's stock default privileges GRANT ALL on every table in `public` to
 * `anon` and `authenticated` — a TABLE-level grant. So in THIS codebase a bare
 * column-level REVOKE is always a no-op. It does not error and it does not warn;
 * the migration reports success and changes nothing.
 *
 * That is not hypothetical. It is what happened to migration 0005's F-1 fix
 * (self-grant of platform admin) — the single most severe finding in the audit,
 * "closed" by a statement that does nothing. See the allowlist below.
 *
 * The only pattern that works against a table-level grant is:
 *
 *     revoke <priv> on <table> from anon, authenticated;    -- kill table-level
 *     grant  <priv> (<safe cols>) on <table> to <role>;     -- re-grant narrowly
 *
 * This test pins that pattern so the class of bug cannot come back silently in a
 * migration nobody can run locally (they are applied by hand in the Supabase SQL
 * editor — there is no psql or CLI in this environment, so a mistake here is
 * discovered in production or not at all).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations')

/**
 * Migrations known to contain a standalone column-level REVOKE, with the reason
 * it is tolerated. Anything NOT on this list must use the revoke-then-regrant
 * pattern.
 *
 * This list should only ever shrink.
 */
const KNOWN_INERT_COLUMN_REVOKES: Record<string, string> = {
  '0005_emergency_rls_hardening.sql':
    'Its column REVOKEs on public.profiles are inert against Supabase table-level default grants. ' +
    'Superseded by 0010_fix_profiles_privilege_revoke.sql, which drops the table-level privilege first. ' +
    'Left in place unedited because it is already applied to the live database and rewriting an applied ' +
    'migration would misrepresent what was run.',
}

interface Statement {
  file: string
  raw: string
  privileges: string[]
  table: string
}

const normalizeTable = (t: string) => t.replace(/"/g, '').replace(/^public\./, '').toLowerCase()
const splitPrivs = (p: string) =>
  p
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/** `revoke <privs> ( <cols> ) on <table> from …` — the column-level form. */
const COLUMN_REVOKE_RE = /revoke\s+([a-z][a-z, ]*?)\s*\(([^)]*)\)\s*on\s+([\w."]+)\s+from/gi
/** `grant <privs> ( <cols> ) on <table> to …` — the narrow re-grant. */
const COLUMN_GRANT_RE = /grant\s+([a-z][a-z, ]*?)\s*\(([^)]*)\)\s*on\s+([\w."]+)\s+to/gi
/** `revoke <privs> on <table> from …` — the table-level form (no parens). */
const TABLE_REVOKE_RE = /revoke\s+([a-z][a-z, ]*?)\s+on\s+(?!function\b)([\w."]+)\s+from/gi

function parse(file: string, source: string, re: RegExp): Statement[] {
  const out: Statement[] = []
  for (const m of source.matchAll(re)) {
    out.push({ file, raw: m[0], privileges: splitPrivs(m[1]), table: normalizeTable(m[3] ?? m[2]) })
  }
  return out
}

function read(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
}

/**
 * Does this file drop the table-level privilege for `table`/`priv`?
 * `revoke all` counts, since ALL subsumes every named privilege.
 */
function hasTableLevelRevoke(source: string, file: string, table: string, priv: string): boolean {
  return parse(file, source, TABLE_REVOKE_RE).some(
    (s) => s.table === table && (s.privileges.includes('all') || s.privileges.includes(priv)),
  )
}

describe('migration lint: the enumeration is not vacuous', () => {
  test('there are migrations to lint', () => {
    const files = migrationFiles()
    assert.ok(files.length >= 8, `found only ${files.length} migrations; the directory scan has gone blind`)
    assert.ok(files.includes('0009_messaging_authz_hardening.sql'))
    assert.ok(files.includes('0010_fix_profiles_privilege_revoke.sql'))
  })

  test('the parser actually finds the statements it is meant to police', () => {
    // 0009 uses the correct pattern on messages; if the regexes stop matching,
    // every assertion below passes for the wrong reason.
    const src = read('0009_messaging_authz_hardening.sql')
    const grants = parse('0009', src, COLUMN_GRANT_RE)
    assert.ok(
      grants.some((g) => g.table === 'messages' && g.privileges.includes('update')),
      'parser found no column-level GRANT UPDATE on messages in 0009 — regex has drifted',
    )
    const revokes = parse('0009', src, TABLE_REVOKE_RE)
    assert.ok(
      revokes.some((r) => r.table === 'messages' && r.privileges.includes('update')),
      'parser found no table-level REVOKE UPDATE on messages in 0009 — regex has drifted',
    )

    // And that it can still see the defect in 0005.
    const legacy = parse('0005', read('0005_emergency_rls_hardening.sql'), COLUMN_REVOKE_RE)
    assert.ok(
      legacy.length > 0,
      'parser found no column-level REVOKE in 0005 — the known-defect fixture is not being detected',
    )
  })
})

describe('column-level privilege changes are paired with a table-level revoke', () => {
  for (const file of migrationFiles()) {
    const source = read(file)

    test(`${file}: every column-level REVOKE follows a table-level REVOKE`, () => {
      const offenders = parse(file, source, COLUMN_REVOKE_RE).filter(
        (s) => !s.privileges.some((p) => hasTableLevelRevoke(source, file, s.table, p)),
      )

      if (KNOWN_INERT_COLUMN_REVOKES[file]) {
        assert.ok(
          offenders.length > 0,
          `${file} is on the KNOWN_INERT allowlist but no longer contains a standalone column REVOKE. ` +
            `If it was fixed, remove it from KNOWN_INERT_COLUMN_REVOKES. Reason on file: ` +
            KNOWN_INERT_COLUMN_REVOKES[file],
        )
        return
      }

      assert.deepEqual(
        offenders.map((o) => o.raw),
        [],
        `${file} revokes a COLUMN privilege without first revoking it at TABLE level. ` +
          'Against Supabase default grants that is a silent no-op. Use:\n' +
          '  revoke <priv> on <table> from anon, authenticated;\n' +
          '  grant  <priv> (<safe cols>) on <table> to authenticated;',
      )
    })

    test(`${file}: every narrow re-GRANT is preceded by a table-level REVOKE`, () => {
      // A column-level GRANT without dropping the table-level privilege first
      // widens nothing and narrows nothing — it reads as a lockdown but leaves
      // the table-level grant intact.
      const offenders = parse(file, source, COLUMN_GRANT_RE).filter(
        (s) => !s.privileges.some((p) => hasTableLevelRevoke(source, file, s.table, p)),
      )

      assert.deepEqual(
        offenders.map((o) => o.raw),
        [],
        `${file} grants a COLUMN privilege without a matching table-level REVOKE. ` +
          'On its own that does not restrict anything — the table-level grant still applies.',
      )
    })
  }
})

describe('0010 closes the specific hole 0005 left open', () => {
  const src = read('0010_fix_profiles_privilege_revoke.sql')

  test('it drops the table-level INSERT and UPDATE on profiles', () => {
    for (const priv of ['insert', 'update']) {
      assert.ok(
        hasTableLevelRevoke(src, '0010', 'profiles', priv),
        `0010 does not revoke table-level ${priv.toUpperCase()} on profiles — the fix would be inert, ` +
          'which is the exact defect it exists to repair',
      )
    }
  })

  test('is_admin is never re-granted to a client role', () => {
    // The whole point. If is_admin appears in a re-grant column list, F-1 is
    // open again and every admin RLS policy plus requireAdmin falls with it.
    for (const g of parse('0010', src, COLUMN_GRANT_RE)) {
      if (g.table !== 'profiles') continue
      const cols = g.raw.toLowerCase()
      assert.ok(
        !/\bis_admin\b/.test(cols),
        `0010 re-grants is_admin to a client role: ${g.raw}`,
      )
      assert.ok(
        !/\bverified_at\b/.test(cols),
        `0010 re-grants verified_at to a client role: ${g.raw}`,
      )
    }

    // And the column list is built dynamically from an array literal, so check
    // the source of that list too.
    const writableBlock = src.slice(src.indexOf('writable text[]'), src.indexOf('present text[]'))
    assert.ok(writableBlock.length > 0, 'could not locate the writable-column allowlist in 0010')
    assert.ok(!/'is_admin'/.test(writableBlock), "0010's writable column list contains is_admin")
    assert.ok(!/'verified_at'/.test(writableBlock), "0010's writable column list contains verified_at")
  })
})
