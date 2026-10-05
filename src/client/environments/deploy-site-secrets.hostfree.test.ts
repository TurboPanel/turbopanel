/**
 * Host-free coverage for sealing a site's secret runtime variables for the
 * target daemon.
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { encryptSecret, isDaemonSealedEnvelope } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import type { EnvironmentDeployHosting } from '../../contracts/commands/schemas.ts'
import { sealHostingWebSecretsForDaemon } from './deploy-prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-4000-8000-0000000000e1'
const KEY_ID = '00000000-0000-4000-8000-0000000000f1'

/** Drizzle-shaped double: every `await` consumes the next queued result set. */
function fakeDb(resultSets: unknown[][]): Db {
  const queue = [...resultSets]
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          const promise = Promise.resolve(queue.shift() ?? [])
          return promise.then.bind(promise)
        }
        if (prop === 'catch' || prop === 'finally') return undefined
        return () => chain
      },
    }
  )
  return chain as Db
}

function mockContext(vars: Record<string, unknown> = {}): Context<AppEnv> {
  return { get: (key: string) => vars[key] } as unknown as Context<AppEnv>
}

function daemonStateRow(revokedAt: string | null = null) {
  return {
    id: KEY_ID,
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'dGVzdGtleQ' },
    fingerprint: 'fp-1',
    createdAt: '2020-01-01T00:00:00.000Z',
    revokedAt,
    lastUsedAt: null,
    daemon: null,
    metadata: {},
    hostname: 'host',
    machineKey: 'mk',
    connected: true,
    statusChangedAt: '2020-01-01T00:00:00.000Z',
  }
}

function hosting(name: string, web?: EnvironmentDeployHosting['web']): EnvironmentDeployHosting {
  return {
    hostingId: `h-${name}`,
    serviceId: `s-${name}`,
    composeServiceName: name,
    hostnames: [`${name}.example.test`],
    ...(web ? { web } : {}),
  }
}

async function sealingContext() {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  return {
    ctx: mockContext({ secretsConfig, dataEncryptionSecrets }),
    atRest: (plaintext: string) => encryptSecret(dataEncryptionSecrets, plaintext),
  }
}

test('site secret variables are resealed for the daemon and plain ones are left alone', async () => {
  const { ctx, atRest } = await sealingContext()
  const stored = await atRest('alpha')
  const out = await sealHostingWebSecretsForDaemon(ctx, fakeDb([[daemonStateRow()]]), SERVER_ID, [
    hosting('web', {
      env: { APP_ENV: 'production' },
      secretEnv: { SITE_VAR: stored },
    }),
    hosting('static'),
  ])
  if (out instanceof Response) throw new TypeError('expected sealed hostings')
  const sealed = out[0]?.web?.secretEnv?.SITE_VAR
  assertEquals(typeof sealed, 'string')
  assertEquals(isDaemonSealedEnvelope(sealed ?? ''), true)
  assertNotEquals(sealed, stored)
  assertEquals(JSON.stringify(out).includes('alpha'), false)
  assertEquals(out[0]?.web?.env, { APP_ENV: 'production' })
  assertEquals(out[1], hosting('static'))
})

test('a deploy with no secret site variable needs no daemon key', async () => {
  const hostings = [hosting('web', { env: { APP_ENV: 'production' } })]
  // No encryption context at all, and no daemon-state query queued.
  const out = await sealHostingWebSecretsForDaemon(mockContext(), fakeDb([]), SERVER_ID, hostings)
  assertEquals(out, hostings)
})

test('secret site variables are refused when the daemon has no active key', async () => {
  const { ctx, atRest } = await sealingContext()
  const stored = await atRest('alpha')
  const out = await sealHostingWebSecretsForDaemon(
    ctx,
    fakeDb([[daemonStateRow('2024-01-01T00:00:00.000Z')]]),
    SERVER_ID,
    [hosting('web', { secretEnv: { SITE_VAR: stored } })]
  )
  if (!(out instanceof Response)) throw new TypeError('expected a refusal')
  assertEquals(out.status, 422)
})

test('secret site variables are refused when no encryption key is configured', async () => {
  const out = await sealHostingWebSecretsForDaemon(mockContext(), fakeDb([]), SERVER_ID, [
    hosting('web', { secretEnv: { SITE_VAR: 'tpsecret.x' } }),
  ])
  if (!(out instanceof Response)) throw new TypeError('expected a refusal')
  assertEquals(out.status, 503)
})
