import { assertEquals, assertThrows } from '@std/assert'
import { parseRehydrateRequestBody } from './rehydrate-secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseRehydrateRequestBody requires deployments array', () => {
  assertThrows(
    () => parseRehydrateRequestBody({}),
    TypeError,
    'deployments must be an array',
  )
})

test('parseRehydrateRequestBody keeps valid entries and drops junk', () => {
  const parsed = parseRehydrateRequestBody({
    deployments: [
      { projectId: 'p1', environmentId: 'e1', generation: 3 },
      { projectId: 'p2' },
      'nope',
      { projectId: 'p3', environmentId: 'e3' },
    ],
  })
  assertEquals(parsed, [
    { projectId: 'p1', environmentId: 'e1', generation: 3 },
    { projectId: 'p3', environmentId: 'e3' },
  ])
})
