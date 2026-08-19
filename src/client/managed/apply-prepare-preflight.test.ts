import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../authn/secrets.ts'
import { preflightManagedApplyInfrastructure } from './apply-prepare.ts'
import { createPreflightDb } from './server-status-test-db.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const secretsConfig = {} as SecretsConfig
const dataEncryptionSecrets = {} as DerivedSecretsConfig

function mockContext(
  secrets?: {
    secretsConfig?: SecretsConfig
    dataEncryptionSecrets?: DerivedSecretsConfig
  },
): Context<AppEnv> {
  const values = new Map<string, unknown>()
  if (secrets?.secretsConfig) {
    values.set('secretsConfig', secrets.secretsConfig)
  }
  if (secrets?.dataEncryptionSecrets) {
    values.set('dataEncryptionSecrets', secrets.dataEncryptionSecrets)
  }
  return {
    get(key: string) {
      return values.get(key)
    },
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

test('preflightManagedApplyInfrastructure rejects missing secrets config', async () => {
  const c = mockContext()
  const result = await preflightManagedApplyInfrastructure(
    c,
    createPreflightDb({
      serverId: 'server-1',
    }),
    {
      serverId: 'server-1',
      scope: 'public',
    },
  )
  assertEquals(result, {
    kind: 'daemon_key_unavailable',
    serverId: 'server-1',
  })
})

test('preflightManagedApplyInfrastructure rejects missing dataEncryptionSecrets only', async () => {
  const c = mockContext({ secretsConfig })
  const result = await preflightManagedApplyInfrastructure(
    c,
    createPreflightDb({ serverId: 'server-2' }),
    { serverId: 'server-2', scope: 'local' },
  )
  assertEquals(result, {
    kind: 'daemon_key_unavailable',
    serverId: 'server-2',
  })
})

test('preflightManagedApplyInfrastructure rejects missing secretsConfig only', async () => {
  const c = mockContext({ dataEncryptionSecrets })
  const result = await preflightManagedApplyInfrastructure(
    c,
    createPreflightDb({ serverId: 'server-3' }),
    { serverId: 'server-3', scope: 'local' },
  )
  assertEquals(result, {
    kind: 'daemon_key_unavailable',
    serverId: 'server-3',
  })
})

test('preflightManagedApplyInfrastructure rejects inactive daemon keys', async () => {
  const c = mockContext({
    secretsConfig,
    dataEncryptionSecrets,
  })

  const result = await preflightManagedApplyInfrastructure(
    c,
    createPreflightDb({ serverId: 'server-9', daemonState: null }),
    {
      serverId: 'server-9',
      scope: 'local',
    },
  )
  assertEquals(result, {
    kind: 'daemon_key_unavailable',
    serverId: 'server-9',
  })
})

test('preflightManagedApplyInfrastructure surfaces datacenter IP requirements', async () => {
  const c = mockContext({
    secretsConfig,
    dataEncryptionSecrets,
  })

  const result = await preflightManagedApplyInfrastructure(
    c,
    createPreflightDb({ serverId: 'server-dc' }),
    {
      serverId: 'server-dc',
      scope: 'datacenter',
    },
  )
  assertEquals(result, {
    kind: 'datacenter_ip_required',
    serverId: 'server-dc',
  })
})

test('preflightManagedApplyInfrastructure succeeds when bind resolves', async () => {
  const c = mockContext({
    secretsConfig,
    dataEncryptionSecrets,
  })

  const publicResult = await preflightManagedApplyInfrastructure(
    c,
    createPreflightDb({ serverId: 'server-ok' }),
    {
      serverId: 'server-ok',
      scope: 'public',
    },
  )
  assertEquals(publicResult, null)

  const localResult = await preflightManagedApplyInfrastructure(
    c,
    createPreflightDb({ serverId: 'server-ok' }),
    {
      serverId: 'server-ok',
      scope: 'local',
    },
  )
  assertEquals(localResult, null)

  const datacenterResult = await preflightManagedApplyInfrastructure(
    c,
    createPreflightDb({
      serverId: 'server-dc-ok',
      datacenterAddress: '203.0.113.10',
    }),
    {
      serverId: 'server-dc-ok',
      scope: 'datacenter',
    },
  )
  assertEquals(datacenterResult, null)
})

test('preflightManagedApplyInfrastructure accepts public bind without datacenter IP rows', async () => {
  const c = mockContext({
    secretsConfig,
    dataEncryptionSecrets,
  })

  const result = await preflightManagedApplyInfrastructure(
    c,
    createPreflightDb({ serverId: 'server-public-only' }),
    {
      serverId: 'server-public-only',
      scope: 'public',
    },
  )
  assertEquals(result, null)
})
