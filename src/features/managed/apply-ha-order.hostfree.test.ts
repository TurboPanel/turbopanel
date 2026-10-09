import { assertEquals } from '@std/assert'
import { decryptSecretForDaemon } from '../../lib/secrets/data-encryption.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  buildOrganizationTopologyUser,
  deriveOrganizationTopologyCredential,
} from './topology-credential.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const RECIPIENT = {
  serverId: '33333333-3333-4333-8333-333333333333',
  keyId: '44444444-4444-4444-8444-444444444444',
}

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}`)
  if (start < 0) return ''
  const next = source.indexOf('\nasync function ', start + 1)
  return next > start ? source.slice(start, next) : source.slice(start)
}

test('primary apply and managed.ha.reconcile share organization topology credentials', async () => {
  const secrets = parseTestSecretsConfig()
  const derived = await deriveOrganizationTopologyCredential(secrets, ORG_ID)
  const field = await buildOrganizationTopologyUser(secrets, RECIPIENT, ORG_ID)
  assertEquals(field.username, derived.username)
  assertEquals(await decryptSecretForDaemon(secrets, RECIPIENT, field.password), derived.password)
})

test('apply enqueue does not queue managed.ha.reconcile before primary success', async () => {
  const source = await Deno.readTextFile(new URL('./apply-prepare.ts', import.meta.url))
  const body = sliceFunction(source, 'finalizePreparedManagedApplyResults')
  assertEquals(body.includes('enqueueManagedHaReconcile'), false)
  assertEquals(body.includes('managed.ha.reconcile'), false)
})

test('managed.apply success fans out HA reconcile only for MySQL-family primaries', async () => {
  const source = await Deno.readTextFile(new URL('../commands/consumer.ts', import.meta.url))
  const body = sliceFunction(source, 'applyManagedApplySideEffect')
  assertEquals(body.includes('fanOutManagedHaReconcile'), true)
  assertEquals(body.includes('orchestratorManagesEngine'), true)
  assertEquals(body.includes('isPrimary'), true)
})
