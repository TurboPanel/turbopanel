import { assertEquals } from 'jsr:@std/assert'
import { validateRegisteredExternalDockerNetworks } from './validate-docker-external-networks.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type NetworkLookupRow = {
  serverId: string | null
  options: unknown
  metadata: unknown
}

function createNetworkLookupDb(
  rows: NetworkLookupRow[],
): Parameters<typeof validateRegisteredExternalDockerNetworks>[0] {
  return {
    select() {
      return {
        from() {
          return {
            async where() {
              return rows
            },
          }
        },
      }
    },
  } as Parameters<typeof validateRegisteredExternalDockerNetworks>[0]
}

test('validateRegisteredExternalDockerNetworks returns null when empty', async () => {
  const db = createNetworkLookupDb([])
  assertEquals(
    await validateRegisteredExternalDockerNetworks(db, 'org', 'srv', []),
    null,
  )
})

test('validateRegisteredExternalDockerNetworks accepts org-wide and server-scoped rows', async () => {
  const db = createNetworkLookupDb([
    {
      serverId: null,
      options: { dockerNetworkName: 'shared-a' },
      metadata: null,
    },
    {
      serverId: 'srv-1',
      options: { dockerNetworkName: 'shared-b' },
      metadata: null,
    },
  ])
  assertEquals(
    await validateRegisteredExternalDockerNetworks(db, 'org', 'srv-1', [
      'shared-b',
      'shared-a',
    ]),
    null,
  )
})

test('validateRegisteredExternalDockerNetworks reports missing names sorted', async () => {
  const db = createNetworkLookupDb([
    {
      serverId: null,
      options: { dockerNetworkName: 'known' },
      metadata: null,
    },
  ])
  assertEquals(
    await validateRegisteredExternalDockerNetworks(db, 'org', 'srv-1', [
      'zeta',
      'alpha',
      'known',
    ]),
    ['alpha', 'zeta'],
  )
})
