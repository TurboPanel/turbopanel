import { assertEquals, assertRejects } from '@std/assert'
import { decryptSecretForDaemon } from '../../lib/secrets/data-encryption.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  buildOrganizationOrchestratorApiUser,
  buildOrganizationOrchestratorRaftToken,
  deriveOrganizationOrchestratorApiCredential,
  deriveOrganizationOrchestratorRaftToken,
  ORCHESTRATOR_API_PASSWORD_LENGTH,
  orchestratorApiUsernameForOrganization,
} from './orchestrator-api-credential.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '11111111-1111-4111-8111-111111111111'

test('orchestratorApiUsernameForOrganization is deterministic and within engine limits', () => {
  assertEquals(orchestratorApiUsernameForOrganization(ORG_ID), 'tp_orchapi_111111111111')
})

test('deriveOrganizationOrchestratorApiCredential is stable for the same org and secret', async () => {
  const secrets = parseTestSecretsConfig()
  const first = await deriveOrganizationOrchestratorApiCredential(secrets, ORG_ID)
  const second = await deriveOrganizationOrchestratorApiCredential(secrets, ORG_ID)
  assertEquals(first.username, second.username)
  assertEquals(first.password, second.password)
  assertEquals(first.password.length, ORCHESTRATOR_API_PASSWORD_LENGTH)
})

test('deriveOrganizationOrchestratorRaftToken differs from the API password', async () => {
  const secrets = parseTestSecretsConfig()
  const api = await deriveOrganizationOrchestratorApiCredential(secrets, ORG_ID)
  const raft = await deriveOrganizationOrchestratorRaftToken(secrets, ORG_ID)
  assertEquals(api.password === raft, false)
})

test('buildOrganizationOrchestratorApiUser seals the derived password to one daemon', async () => {
  const secrets = parseTestSecretsConfig()
  const recipient = {
    serverId: '33333333-3333-4333-8333-333333333333',
    keyId: '44444444-4444-4444-8444-444444444444',
  }
  const derived = await deriveOrganizationOrchestratorApiCredential(secrets, ORG_ID)
  const field = await buildOrganizationOrchestratorApiUser(secrets, recipient, ORG_ID)

  assertEquals(field.username, derived.username)
  assertEquals(field.password.startsWith('tpdaemon.'), true)
  assertEquals(await decryptSecretForDaemon(secrets, recipient, field.password), derived.password)
})

test('buildOrganizationOrchestratorRaftToken seals the derived token to one daemon', async () => {
  const secrets = parseTestSecretsConfig()
  const recipient = {
    serverId: '33333333-3333-4333-8333-333333333333',
    keyId: '44444444-4444-4444-8444-444444444444',
  }
  const derived = await deriveOrganizationOrchestratorRaftToken(secrets, ORG_ID)
  const sealed = await buildOrganizationOrchestratorRaftToken(secrets, recipient, ORG_ID)
  assertEquals(sealed.startsWith('tpdaemon.'), true)
  assertEquals(await decryptSecretForDaemon(secrets, recipient, sealed), derived)
})

test('an orchestrator API envelope sealed for one daemon is refused for another', async () => {
  const secrets = parseTestSecretsConfig()
  const recipient = {
    serverId: '33333333-3333-4333-8333-333333333333',
    keyId: '44444444-4444-4444-8444-444444444444',
  }
  const field = await buildOrganizationOrchestratorApiUser(secrets, recipient, ORG_ID)
  await assertRejects(() =>
    decryptSecretForDaemon(
      secrets,
      { ...recipient, serverId: '55555555-5555-4555-8555-555555555555' },
      field.password
    )
  )
})
