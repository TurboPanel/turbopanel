import { assertEquals } from '@std/assert'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { headlessManagedContext } from './headless-context.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('headlessManagedContext get() answers secrets keys and json() is a Response', async () => {
  const secretsConfig = { name: 'secrets' } as unknown as SecretsConfig
  const dataEncryptionSecrets = { name: 'denc' } as unknown as DerivedSecretsConfig
  const c = headlessManagedContext({ secretsConfig, dataEncryptionSecrets })
  assertEquals(c.get('secretsConfig'), secretsConfig)
  assertEquals(c.get('dataEncryptionSecrets'), dataEncryptionSecrets)
  assertEquals(c.get('session'), undefined)
  const response = c.json({ error: 'command queue unavailable' }, 503)
  assertEquals(response.status, 503)
  assertEquals(await response.json(), { error: 'command queue unavailable' })
})
