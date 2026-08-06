import { assertEquals } from '@std/assert'

import {
  buildDevSyncTarArgs,
  DEV_SYNC_RUNTIME_LOCAL_EXCLUDES,
  DEV_SYNC_SOURCE_ALLOWLIST,
} from './dev-sync-archive.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 *
 * Sibling `dev-sync-archive.test.ts` is Vitest-only and does not feed Deno LCOV.
 */
const test = Deno.test.bind(Deno)

test('buildDevSyncTarArgs excludes host-local paths before the allowlist', () => {
  const args = buildDevSyncTarArgs('/repo', '/tmp/out.tgz')
  assertEquals(args[0], '-czf')
  assertEquals(args[1], '/tmp/out.tgz')
  assertEquals(args[2], '-C')
  assertEquals(args[3], '/repo')
  assertEquals(args.includes('--exclude=.env'), true)
  assertEquals(args.includes('orchestration'), true)
  assertEquals([...DEV_SYNC_SOURCE_ALLOWLIST], [
    'main.ts',
    'deno.json',
    'deno.lock',
    'src',
    'orchestration',
    'scripts',
  ])
  assertEquals(DEV_SYNC_RUNTIME_LOCAL_EXCLUDES.includes('.env'), true)
})
