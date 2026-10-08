import { assertEquals, assertRejects } from '@std/assert'
import { decryptSecretForDaemon } from '../../lib/secrets/data-encryption.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  buildOrganizationTopologyUser,
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
  assertEquals(topologyUsernameForOrganization(ORG_ID), 'tp_topology_111111111111')
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

test('buildOrganizationTopologyUser seals the derived password to one daemon', async () => {
  const secrets = parseTestSecretsConfig()
  const recipient = {
    serverId: '33333333-3333-4333-8333-333333333333',
    keyId: '44444444-4444-4444-8444-444444444444',
  }
  const derived = await deriveOrganizationTopologyCredential(secrets, ORG_ID)
  const field = await buildOrganizationTopologyUser(secrets, recipient, ORG_ID)

  assertEquals(field.username, derived.username)
  assertEquals(field.password.startsWith('tpdaemon.'), true)
  assertEquals(field.password.includes(derived.password), false)
  assertEquals(await decryptSecretForDaemon(secrets, recipient, field.password), derived.password)
})

test('a topology envelope sealed for one daemon is refused for another', async () => {
  const secrets = parseTestSecretsConfig()
  const recipient = {
    serverId: '33333333-3333-4333-8333-333333333333',
    keyId: '44444444-4444-4444-8444-444444444444',
  }
  const field = await buildOrganizationTopologyUser(secrets, recipient, ORG_ID)
  await assertRejects(() =>
    decryptSecretForDaemon(
      secrets,
      { ...recipient, serverId: '55555555-5555-4555-8555-555555555555' },
      field.password
    )
  )
})
