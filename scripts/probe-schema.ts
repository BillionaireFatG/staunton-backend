/**
 * TEMPORARY schema probe. Reads the PostgREST OpenAPI document, which lists
 * every table/view exposed on the `public` schema together with its real column
 * set, plus every callable RPC. This is the only way to establish ground truth
 * about the live database from this environment (no psql, no Supabase CLI).
 *
 * Why not `select ... limit 1`: an empty table returns [] and tells you nothing,
 * and a HEAD+count request against a MISSING table returns a null count WITHOUT
 * erroring — which produced a false positive earlier in this project.
 */
import 'dotenv/config'

const url = process.env.SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!

async function main() {
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' },
  })
  const spec: any = await res.json()

  const wanted = process.argv.slice(2)
  const defs = spec.definitions ?? {}
  const names = Object.keys(defs).sort()

  console.log('=== EXPOSED TABLES/VIEWS (%d) ===', names.length)
  console.log(names.join(', '))

  const targets = wanted.length ? wanted : names
  for (const t of targets) {
    const d = defs[t]
    if (!d) {
      console.log(`\n--- ${t}: NOT EXPOSED (absent from OpenAPI) ---`)
      continue
    }
    console.log(`\n--- ${t} ---`)
    for (const [col, meta] of Object.entries<any>(d.properties ?? {})) {
      const req = (d.required ?? []).includes(col) ? ' NOT NULL' : ''
      console.log(`  ${col}: ${meta.format ?? meta.type}${req}${meta.description ? '  // ' + String(meta.description).replace(/\n/g, ' ') : ''}`)
    }
  }

  console.log('\n=== RPCs ===')
  const rpcs = Object.keys(spec.paths ?? {}).filter((p) => p.startsWith('/rpc/')).sort()
  console.log(rpcs.join('\n'))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
