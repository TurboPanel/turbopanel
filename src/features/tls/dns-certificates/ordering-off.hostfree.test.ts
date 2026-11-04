/**
 * The control plane no longer orders DNS-validated certificates, on either
 * edition. Read from the import graph, with no database and no network: the
 * modules that open, carry on or renew an order (and make the account) are not
 * reachable from the Workers entry or the Deno entry, so no request and no
 * sweep tick can place an order. The sweep's leftover-record cleanup is
 * reachable from both, and nothing it imports talks to the certificate
 * authority.
 */
import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join, normalize, relative } from '@std/path'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

const SRC = normalize(join(dirname(fromFileUrl(import.meta.url)), '../../..'))
const FEATURE = 'features/tls/dns-certificates'

/** The modules that talk to the certificate authority to order or renew. */
const ORDERING = ['issuance.ts', 'steps.ts', 'account.ts', 'sweep.ts', 'sweep-select.ts'].map(
  (file) => `${FEATURE}/${file}`
)

/** Relative imports that run code: `import type` and `export type` are left out. */
const IMPORT =
  /(?:^|[\s;])(import|export)(\s+type\b)?(?:[^'";]*?\bfrom\s*)?\s*['"](\.{1,2}\/[^'"]+)['"]/g
const DYNAMIC = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g

function importsOf(file: string, text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(IMPORT)) {
    if (m[2]) continue
    out.push(normalize(join(dirname(file), m[3]!)))
  }
  for (const m of text.matchAll(DYNAMIC)) out.push(normalize(join(dirname(file), m[1]!)))
  return out
}

/** Every source file reachable from `entry` (paths relative to `src/`). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [normalize(join(SRC, entry))]
  while (queue.length > 0) {
    const file = queue.pop()!
    const key = relative(SRC, file)
    if (seen.has(key) || !/\.(ts|tsx|mjs|js)$/.test(file)) continue
    let text: string
    try {
      text = Deno.readTextFileSync(file)
    } catch {
      continue
    }
    seen.add(key)
    queue.push(...importsOf(file, text))
  }
  return seen
}

test('the import reader keeps code imports and leaves type-only ones out', () => {
  const file = join(SRC, 'a/b.ts')
  const text = [
    "import { x } from './x.ts'",
    "import type { Y } from './y.ts'",
    "export { z } from '../z.ts'",
    "export type { W } from './w.ts'",
    "import './side.ts'",
    'import {\n  many,\n  names,\n} from "./multi.ts"',
    "const later = await import('./later.ts')",
  ].join('\n')
  assertEquals(
    importsOf(file, text)
      .map((p) => relative(SRC, p))
      .sort(),
    ['a/later.ts', 'a/multi.ts', 'a/side.ts', 'a/x.ts', 'z.ts']
  )
})

for (const entry of ['workers.ts', 'deno.ts']) {
  test(`${entry}: no ordering or renewal code of DNS-validated certificates is reachable`, () => {
    const graph = reachable(entry)
    // Positive controls: the sweep and the routes are wired, so an empty graph cannot pass.
    assert(graph.has('client/organizations/dns-certificate-routes.ts'), entry)
    assert(graph.has(`${FEATURE}/cleanup.ts`), entry)
    assertEquals(
      ORDERING.filter((file) => graph.has(file)),
      [],
      entry
    )
  })
}

test('the leftover-record cleanup never reaches the certificate authority client', () => {
  const graph = reachable(`${FEATURE}/cleanup.ts`)
  assert(graph.has(`${FEATURE}/records.ts`))
  assertEquals(
    [...graph].filter((file) => file.startsWith('lib/acme/') || ORDERING.includes(file)),
    []
  )
})
