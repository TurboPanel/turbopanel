import { assertEquals } from '@std/assert'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  deriveOrganizationTopologyCredential,
  TOPOLOGY_PASSWORD_LENGTH,
  topologyUsernameForOrganization,
} from './topology-credential.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '11111111-1111-4111-8111-111111111111'

test('topologyUsernameForOrganization is deterministic and within engine limits', () => {
  assertEquals(
    topologyUsernameForOrganization(ORG_ID),
    'tp_topology_111111111111'
  )
})

test('deriveOrganizationTopologyCredential is stable for the same org and secret', async () => {
  const secrets = parseTestSecretsConfig()
  const first = await deriveOrganizationTopologyCredential(secrets, ORG_ID)
  const second = await deriveOrganizationTopologyCredential(secrets, ORG_ID)
  assertEquals(first.username, second.username)
  assertEquals(first.password, second.password)
  assertEquals(first.password.length, TOPOLOGY_PASSWORD_LENGTH)
})

test('deriveOrganizationTopologyCredential differs across organizations', async () => {
  const secrets = parseTestSecretsConfig()
  const a = await deriveOrganizationTopologyCredential(secrets, ORG_ID)
  const b = await deriveOrganizationTopologyCredential(
    secrets,
    '22222222-2222-4222-8222-222222222222'
  )
  assertEquals(a.username === b.username, false)
  assertEquals(a.password === b.password, false)
})
