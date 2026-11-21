/**
 * Host-free coverage for the `composeCheckout` entry of a Git Compose project:
 * which commit it names, who it is sealed for, and when it is absent.
 */

import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { encryptSecret, isDaemonSealedEnvelope } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import type { ComposeBaseRecord } from '../../features/projects/project-options.ts'
import { resolveDeployComposeCheckout } from './deploy-compose-checkout.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const COMMIT = 'c'.repeat(40)
const SOURCE_ID = '00000000-0000-4000-8000-0000000000c1'
const SERVER_ID = '00000000-0000-4000-8000-0000000000e1'
const KEY_ID = '00000000-0000-4000-8000-0000000000f1'
const CREDENTIAL_ID = '00000000-0000-4000-8000-0000000000d1'

const BASE: ComposeBaseRecord = {
  sourceId: SOURCE_ID,
  ref: 'main',
  path: 'deploy/compose.yaml',
  commitSha: COMMIT,
  digest: 'd'.repeat(64),
}

/** Each `await` on the double consumes the next queued result set. */
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

function repositoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    provider: 'git',
    repositoryUrl: 'https://git.example.net/acme/stack.git',
    defaultBranch: 'main',
    subdirectory: null,
    connectionId: null,
    secretId: null,
    ...overrides,
  }
}

function daemonStateRow() {
  return {
    id: KEY_ID,
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'dGVzdGtleQ' },
    fingerprint: 'fp-1',
    createdAt: '2020-01-01T00:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
    daemon: null,
    metadata: {},
    hostname: 'host',
    machineKey: 'mk',
    connected: true,
    statusChangedAt: '2020-01-01T00:00:00.000Z',
  }
}

const deployParams = {
  mode: 'deploy' as const,
  organizationId: 'org-1',
  serverId: SERVER_ID,
  composeBase: BASE,
}

test('a project that follows no file has nothing to check out', async () => {
  assertEquals(
    await resolveDeployComposeCheckout(mockContext(), fakeDb([]), {
      ...deployParams,
      composeBase: null,
    }),
    undefined
  )
})

test('a preview sends no checkout and seals nothing', async () => {
  assertEquals(
    await resolveDeployComposeCheckout(mockContext(), fakeDb([]), {
      ...deployParams,
      mode: 'preview',
    }),
    undefined
  )
})

test('the checkout names the commit the compose file was read from', async () => {
  const result = await resolveDeployComposeCheckout(
    mockContext(),
    fakeDb([[repositoryRow()], [daemonStateRow()]]),
    deployParams
  )
  // A plain Git remote answers with the ref as its commit; the Base wins.
  assertEquals(result, {
    sourceId: SOURCE_ID,
    provider: 'git',
    cloneUrl: 'https://git.example.net/acme/stack.git',
    ref: 'main',
    commitSha: COMMIT,
    composePath: 'deploy/compose.yaml',
  })
})

test('a stored credential is sealed for the target daemon, never plain', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const atRest = await encryptSecret(dataEncryptionSecrets, 'clone-token')
  const result = await resolveDeployComposeCheckout(
    mockContext({ secretsConfig, dataEncryptionSecrets }),
    fakeDb([
      [repositoryRow({ secretId: CREDENTIAL_ID })],
      [daemonStateRow()],
      [{ secretEnvelope: atRest }],
    ]),
    deployParams
  )
  if (result === undefined || result instanceof Response || 'kind' in result) {
    throw new TypeError('expected a checkout entry')
  }
  assertEquals(result.credentialKind, 'token')
  if (typeof result.credential !== 'string') throw new TypeError('expected a sealed credential')
  assertEquals(isDaemonSealedEnvelope(result.credential), true)
  assertEquals(JSON.stringify(result).includes('clone-token'), false)
})

test('an SSH repository is cloned with its deploy key as an identity', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const result = await resolveDeployComposeCheckout(
    mockContext({ secretsConfig, dataEncryptionSecrets }),
    fakeDb([
      [
        repositoryRow({
          secretId: CREDENTIAL_ID,
          repositoryUrl: 'git@git.example.net:acme/stack.git',
        }),
      ],
      [daemonStateRow()],
      [{ secretEnvelope: 'plain-deploy-key' }],
    ]),
    deployParams
  )
  if (result === undefined || result instanceof Response || 'kind' in result) {
    throw new TypeError('expected a checkout entry')
  }
  assertEquals(result.credentialKind, 'ssh_key')
})

test('a repository that left the organization is source_ref_unresolved', async () => {
  assertEquals(await resolveDeployComposeCheckout(mockContext(), fakeDb([[]]), deployParams), {
    kind: 'source_ref_unresolved',
    composeServiceName: 'deploy/compose.yaml',
    sourceId: SOURCE_ID,
    ref: 'main',
    message: 'repository not found in this organization',
  })
})

test('a server with no usable daemon key is refused with 422', async () => {
  const result = await resolveDeployComposeCheckout(
    mockContext(),
    fakeDb([[repositoryRow()], []]),
    deployParams
  )
  if (!(result instanceof Response)) throw new TypeError('expected a 422 Response')
  assertEquals(result.status, 422)
})

test('a hostings-only run resolves no checkout and touches nothing', async () => {
  const result = await resolveDeployComposeCheckout(mockContext(), fakeDb([]), {
    mode: 'deploy',
    organizationId: 'org-1',
    serverId: SERVER_ID,
    composeBase: BASE,
    hostingsOnly: true,
  })
  assertEquals(result, undefined)
})
