/**
 * Static enumeration of the API surface, read from `src/app.ts` and
 * `src/routes/*.ts` at test time.
 *
 * Why parse the source instead of hand-listing the endpoints: a hand-written
 * list only ever proves things about the routes someone remembered to add to it.
 * The property worth pinning is "EVERY route behind an authenticated prefix
 * rejects an anonymous caller", and that has to be re-derived from the code on
 * every run, so a route added tomorrow is covered without anyone updating a
 * fixture.
 *
 * This is deliberately a regex parser, not a TypeScript AST walk — no parser
 * dependency is available here. That makes it possible for the parser to go
 * blind (match nothing) and let the suite pass vacuously, so the tests that
 * consume this MUST also assert route counts and that each enumerated path
 * really resolves. See the "the enumeration is not vacuous" test.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

export const SRC_DIR = path.resolve(__dirname, '..', '..', 'src')

/** Placeholder for `:param` segments. Valid UUID so uuid schemas reach the handler. */
export const PARAM_UUID = '11111111-2222-4333-8444-555555555555'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RouteEntry {
  /** e.g. "deals" — the file under src/routes/ */
  module: string
  /** e.g. "/api/deals" */
  prefix: string
  method: HttpMethod
  /** Path as written in the route file, e.g. "/:id/events" */
  rawPath: string
  /** Full injectable URL with :params substituted, e.g. "/api/deals/1111.../events" */
  url: string
  /** Does the route file install `authenticate` as an onRequest hook? */
  authenticated: boolean
}

/**
 * Strip comments so a commented-out `app.get(...)` is not mistaken for a live
 * route. Line comments are only stripped when the line is entirely a comment,
 * which avoids mangling a URL like `https://…` inside a string literal.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
}

function readSource(relative: string): string {
  return readFileSync(path.join(SRC_DIR, relative), 'utf8')
}

/**
 * Map every `app.register(xRoutes, { prefix: '/api/…' })` in app.ts back to the
 * route file that exports it. Reading BOTH the import list and the register
 * calls means a new route file shows up here the moment it is wired up.
 */
export function registeredPrefixes(): Array<{ module: string; prefix: string }> {
  const app = stripComments(readSource('app.ts'))

  const importedFrom = new Map<string, string>()
  const importRe = /import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*['"]\.\/routes\/([A-Za-z0-9_]+)['"]/g
  for (const m of app.matchAll(importRe)) importedFrom.set(m[1], m[2])

  const out: Array<{ module: string; prefix: string }> = []
  const registerRe = /app\.register\(\s*([A-Za-z0-9_]+)\s*,\s*\{\s*prefix:\s*['"]([^'"]+)['"]/g
  for (const m of app.matchAll(registerRe)) {
    const module = importedFrom.get(m[1])
    if (module) out.push({ module, prefix: m[2] })
  }
  return out
}

/** Every route declared in one route file. */
function routesInModule(module: string, prefix: string): RouteEntry[] {
  const source = stripComments(readSource(path.join('routes', `${module}.ts`)))

  // `app.addHook('onRequest', authenticate)` — the plugin-wide auth gate.
  const authenticated = /addHook\(\s*['"]onRequest['"]\s*,\s*authenticate\s*\)/.test(source)

  // Whitespace-tolerant: several routes put the options object on its own line,
  // e.g. `app.post(\n  '/rewards/:rewardId/redeem',\n  { schema: … }`.
  const routeRe = /\bapp\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2/g

  const entries: RouteEntry[] = []
  for (const m of source.matchAll(routeRe)) {
    const method = m[1].toUpperCase() as HttpMethod
    const rawPath = m[3]
    const joined = `${prefix}${rawPath === '/' ? '' : rawPath}`
    const url = joined.replace(/:[A-Za-z0-9_]+/g, PARAM_UUID)
    entries.push({ module, prefix, method, rawPath, url, authenticated })
  }
  return entries
}

/** Every route across every registered prefix. */
export function allRoutes(): RouteEntry[] {
  return registeredPrefixes().flatMap(({ module, prefix }) => routesInModule(module, prefix))
}

/** Routes whose plugin installs `authenticate`. These must all 401 anonymously. */
export function authenticatedRoutes(): RouteEntry[] {
  return allRoutes().filter((r) => r.authenticated)
}

/** Prefixes whose plugin installs `authenticate`, de-duplicated and sorted. */
export function authenticatedPrefixes(): string[] {
  return [...new Set(authenticatedRoutes().map((r) => r.prefix))].sort()
}

/** Prefixes whose plugin does NOT install `authenticate`. */
export function unauthenticatedPrefixes(): string[] {
  const all = allRoutes()
  return [...new Set(all.filter((r) => !r.authenticated).map((r) => r.prefix))].sort()
}
