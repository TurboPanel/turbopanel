/**
 * Host-free coverage for the `gone[]` answer of the daemon secrets rehydrate
 * (no Postgres): a deployment is gone only when its environment row is absent.
 */

import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../db/connection.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../lib/secrets/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { buildDeploymentSecretsRehydrate } from './rehydrate-secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-4000-8000-0000000000b1'
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1'
const ENV_ID = '00000000-0000-4000-8000-0000000000e1'

const identityRow = {
  id: 'key-1',
  algorithm: 'Ed25519',
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
  fingerprint: 'fp-test',
  createdAt: '2020-01-01T00:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
  daemon: null,
  metadata: null,
  hostname: 'host-1',
  machineKey: null,
  connected: true,
  statusChangedAt: '2020-01-01T00:00:00.000Z',
}

/** Ordered select pages: daemon identity, then environment, then deployment. */
function pagedDb(pages: unknown[][]): Db {
  let n = 0
  return {
    select: () => {
      const rows = pages[n] ?? []
      n += 1
      const promise = Promise.resolve(rows)
      const where = {
        limit: () => promise,
        then: promise.then.bind(promise),
      }
      const leaf = { innerJoin: () => leaf, where: () => where }
      return { from: () => leaf }
    },
  } as unknown as Db
}

async function rehydrate(pages: unknown[][]) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const store = new Map<string, unknown>([
    ['dataEncryptionSecrets', dataEncryptionSecrets],
    ['secretsConfig', secretsConfig],
    ['daemonServerId', SERVER_ID],
  ])
  const c = {
    get: (key: string) => store.get(key),
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
  } as unknown as Context
  const result = await buildDeploymentSecretsRehydrate(c, pagedDb(pages), {
    deployments: [{ projectId: PROJECT_ID, environmentId: ENV_ID }],
  })
  if (result instanceof Response) throw new TypeError('expected a payload')
  return result
}

test('rehydrate reports a deployment whose environment row is gone', async () => {
  const result = await rehydrate([[identityRow], []])
  assertEquals(result.deployments, [])
  assertEquals(result.gone, [{ projectId: PROJECT_ID, environmentId: ENV_ID }])
})

test('rehydrate does not report a project mismatch as gone', async () => {
  const result = await rehydrate([[identityRow], [{ id: ENV_ID, projectId: 'other' }]])
  assertEquals(result.deployments, [])
  assertEquals(result.gone, [])
})

test('rehydrate does not report a live environment without a deployment row as gone', async () => {
  const result = await rehydrate([[identityRow], [{ id: ENV_ID, projectId: PROJECT_ID }], []])
  assertEquals(result.deployments, [])
  assertEquals(result.gone, [])
})
