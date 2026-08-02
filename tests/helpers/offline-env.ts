/**
 * Offline env shim. Import this BEFORE anything that pulls in `src/lib/supabase`.
 *
 * `src/lib/supabase.ts` throws at module load when SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY are unset, so a test that never touches the network
 * still cannot import the app without them. This points the client at a port
 * nothing listens on, which gives the offline suites two things:
 *
 *   1. they run identically on a machine with no `.env` and no connectivity, and
 *   2. any accidental round trip fails fast and loudly (ECONNREFUSED) instead of
 *      quietly reading or writing the real dev database.
 *
 * It must be its own module: TypeScript/esbuild hoist `import` statements above
 * top-of-file assignments, so setting these inside the test file itself runs too
 * late.
 */
process.env.SUPABASE_URL = 'http://127.0.0.1:1'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-placeholder-key'

// Rate limiting is disabled per-app via buildApp({ disableRateLimit: true }),
// but TRUST_PROXY would change req.ip handling under us if it leaked in.
delete process.env.TRUST_PROXY

export {}
