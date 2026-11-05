/**
 * The Workers ACME boundary must fail a seeded import of the ACME client from
 * a Workers path, a directory host in a reachable file, a grown or stale
 * exclusion list, and must pass a clean tree and the real checkout.
 */
import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  checkWorkersAcmeBoundary,
  FROZEN_ACME_IMPORTERS,
  WORKERS_REACHABLE,
} from './check-workers-acme-boundary.mjs'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '..')

/** The exclusion list as frozen when the guard landed. It may only shrink. */
const FROZEN_AT_START = [
  'src/features/organizations/acme-terms.ts',
  'src/features/tls/dns-certificates/account.ts',
  'src/features/tls/dns-certificates/issuance.ts',
  'src/features/tls/dns-certificates/messages.ts',
  'src/features/tls/dns-certificates/steps.ts',
  'src/features/tls/dns-certificates/timing.ts',
]

const PRODUCTION_HOST = ['acme-v02', 'api', 'letsencrypt', 'org'].join('.')
const STAGING_HOST = ['acme-staging-v02', 'api', 'letsencrypt', 'org'].join('.')

/** A tree in which every frozen entry imports the client and the tolerated one is reachable. */
function cleanTree(): Record<string, string> {
  const files: Record<string, string> = {
    'src/lib/acme/client.ts': 'export const client = 1\n',
    'src/lib/acme/directories.ts': `export const url = 'https://${PRODUCTION_HOST}/directory'\n`,
    'src/workers.ts':
      "import { terms } from './features/organizations/acme-terms.ts'\n" +
      "import type { Client } from './lib/acme/client.ts'\n" +
      "import { ok } from './client/ok.ts'\nexport default { terms, ok }\n",
    'src/client/ok.ts': 'export const ok = 1\n',
    'src/deno.ts': "import { client } from './lib/acme/client.ts'\nexport const d = client\n",
    'src/platform/deno/ingress/order.ts':
      "import { url } from '../../../lib/acme/directories.ts'\nexport const o = url\n",
    'src/client/x.test.ts':
      "import { client } from '../lib/acme/client.ts'\nexport const t = client\n",
  }
  for (const rel of FROZEN_AT_START) {
    const up = '../'.repeat(rel.split('/').length - 2)
    files[rel] = `import { client } from '${up}lib/acme/client.ts'\nexport const terms = client\n`
  }
  return files
}

async function withTree(
  files: Record<string, string>,
  run: (root: string) => void | Promise<void>
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: 'tp-workers-acme-boundary-' })
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel)
      await Deno.mkdir(dirname(abs), { recursive: true })
      await Deno.writeTextFile(abs, body)
    }
    await run(root)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

function assertFailsWith(root: string, fragment: string): void {
  const failures = checkWorkersAcmeBoundary({ root })
  assert(
    failures.some((line) => line.includes(fragment)),
    `expected "${fragment}" in:\n${failures.join('\n')}`
  )
}

test('a clean tree passes: self-hosted, test-only and type-only imports are allowed', async () => {
  await withTree(cleanTree(), (root) => {
    assertEquals(checkWorkersAcmeBoundary({ root }), [])
  })
})

test('a seeded ACME client import from a Workers path fails', async () => {
  const files = cleanTree()
  files['src/client/ok.ts'] =
    "import { client } from '../lib/acme/client.ts'\nexport const ok = client\n"
  await withTree(files, (root) => {
    assertFailsWith(root, 'src/client/ok.ts imports src/lib/acme')
    assertFailsWith(root, 'src/workers.ts reaches src/lib/acme/client.ts through src/client/ok.ts')
  })
})

test('a dynamic import of the ACME client is caught too', async () => {
  const files = cleanTree()
  files['src/client/ok.ts'] = "export const ok = () => import('../lib/acme/client.ts')\n"
  await withTree(files, (root) => {
    assertFailsWith(root, 'src/workers.ts reaches src/lib/acme/client.ts through src/client/ok.ts')
  })
})

test('a comment that says import neither hides nor invents an import', async () => {
  const typeOnly = cleanTree()
  typeOnly['src/client/ok.ts'] =
    "/** Workers import this file. */\nexport type { Client } from '../lib/acme/client.ts'\nexport const ok = 1\n"
  await withTree(typeOnly, (root) => {
    assertEquals(checkWorkersAcmeBoundary({ root }), [])
  })
  const code = cleanTree()
  code['src/client/ok.ts'] =
    "// import this from the client\nimport { client } from '../lib/acme/client.ts'\nexport const ok = client\n"
  await withTree(code, (root) => {
    assertFailsWith(root, 'src/workers.ts reaches src/lib/acme/client.ts through src/client/ok.ts')
  })
})

test('a frozen entry other than the tolerated one may not become Workers-reachable', async () => {
  const files = cleanTree()
  files['src/client/ok.ts'] =
    "import { terms } from '../features/tls/dns-certificates/timing.ts'\nexport const ok = terms\n"
  await withTree(files, (root) => {
    assertFailsWith(
      root,
      'src/workers.ts reaches src/lib/acme/client.ts through src/features/tls/dns-certificates/timing.ts'
    )
  })
})

test("a Let's Encrypt directory host in a Workers-reachable file fails", async () => {
  for (const host of [PRODUCTION_HOST, STAGING_HOST]) {
    const files = cleanTree()
    files['src/client/ok.ts'] = `export const ok = 'https://${host}/directory'\n`
    await withTree(files, (root) => {
      assertFailsWith(root, "src/client/ok.ts names a Let's Encrypt directory host")
    })
  }
})

test('a stale exclusion entry fails until it is taken off the list', async () => {
  const files = cleanTree()
  files['src/features/tls/dns-certificates/messages.ts'] = 'export const terms = 1\n'
  files['src/workers.ts'] = "import { ok } from './client/ok.ts'\nexport default { ok }\n"
  await withTree(files, (root) => {
    assertFailsWith(root, 'dns-certificates/messages.ts no longer imports src/lib/acme')
    assertFailsWith(root, 'acme-terms.ts is no longer reachable from src/workers.ts')
  })
})

test('the exclusion lists only shrink', () => {
  for (const rel of FROZEN_ACME_IMPORTERS) {
    assert(FROZEN_AT_START.includes(rel), `${rel} was added to FROZEN_ACME_IMPORTERS`)
  }
  for (const rel of WORKERS_REACHABLE) {
    assert(FROZEN_ACME_IMPORTERS.includes(rel), `${rel} is not a frozen ACME importer`)
  }
  assert(WORKERS_REACHABLE.length <= 1, 'WORKERS_REACHABLE grew')
})

test('checkWorkersAcmeBoundary passes on this checkout', () => {
  assertEquals(checkWorkersAcmeBoundary({ root: repoRoot }), [])
})
