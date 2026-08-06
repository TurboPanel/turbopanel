import { assertEquals } from 'jsr:@std/assert'
import { versionPaths, versionSchemas } from './version.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('versionSchemas requires commit and branch', () => {
  const schema = versionSchemas.DaemonVersion as { required: string[] }
  assertEquals(schema.required, ['commit', 'branch'])
})

test('versionPaths documents the co-located daemon checkout endpoint', () => {
  assertEquals(Object.keys(versionPaths), ['/api/daemon/v1/version'])
  const path = versionPaths['/api/daemon/v1/version'] as {
    get: { summary: string }
  }
  assertEquals(path.get.summary, 'Co-located daemon checkout version')
})
