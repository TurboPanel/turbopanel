import { assertEquals } from '@std/assert'
import { splitNativeAppServices } from './native-app.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SOURCE_ID = '11111111-2222-3333-4444-555555555555'

function nodeService(extra: Record<string, unknown> = {}) {
  return {
    'x-turbopanel': {
      serviceKind: 'node',
      source: { sourceId: SOURCE_ID },
      ...extra,
    },
  }
}

test('splitNativeAppServices carries runtime deno and denoVersion, and nothing for Node', () => {
  const { apps } = splitNativeAppServices({
    web: nodeService({ runtime: 'deno', denoVersion: '2.9' }),
    api: nodeService({ nodeVersion: '22' }),
  })
  const byName = Object.fromEntries(apps.map((app) => [app.composeServiceName, app]))
  assertEquals(byName.web?.runtime, 'deno')
  assertEquals(byName.web?.denoVersion, '2.9')
  assertEquals(byName.web?.framework, 'auto')
  // A Node app's spec has neither key: its payload stays what it was.
  assertEquals('runtime' in (byName.api ?? {}), false)
  assertEquals('denoVersion' in (byName.api ?? {}), false)
  assertEquals(byName.api?.nodeVersion, '22')
})

test('a runtime written as node is the same as none', () => {
  const { apps } = splitNativeAppServices({ web: nodeService({ runtime: 'node' }) })
  assertEquals('runtime' in (apps[0] ?? {}), false)
})
