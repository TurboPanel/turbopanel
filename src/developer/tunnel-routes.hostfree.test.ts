import { assertEquals } from '@std/assert'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../app.ts'
import type { DaemonCell, DaemonCellRegistry, PendingRequestRecord } from '../daemon/cell/contracts.ts'
import type { Db } from '../db.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../client/authn/secrets.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import { parseTunnelTokenBody, registerTunnelRoutes } from './tunnel-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-4000-8000-0000000000d1'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => promise,
    orderBy: () => chain,
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => promise.then(onFulfilled, onRejected),
  }
  return chain
}

function createDb(rows: unknown[]): Db {
  return {
    select: () => thenable(rows),
  } as unknown as Db
}

function fleetRow() {
  return {
    id: SERVER_ID,
    daemon: {
      key: {
        id: 'key-1',
        algorithm: 'Ed25519',
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
        fingerprint: 'fp-1',
        createdAt: '2020-01-01T00:00:00.000Z',
      },
      projection: { remoteAddress: '__direct__' },
    },
    metadata: {},
    hostname: 'host-1',
    machineKey: null,
    osId: null,
    osFamily: null,
    osVersion: null,
    osCodename: null,
    osPrettyName: null,
    osArchitecture: null,
    timezone: null,
    isTimeSyncEnabled: null,
    ntpServers: null,
    ntpLastSyncedAt: null,
    connected: true,
    statusChangedAt: '2020-01-01T00:00:00.000Z',
  }
}

function createRegistry(opts: {
  connected?: boolean
  requestStatus?: PendingRequestRecord['status']
  requestError?: string
  throwMessage?: string
} = {}): DaemonCellRegistry {
  const cell = {
    createRequestAndWait: (outbound: { requestId: string; at: string; kind: string }) => {
      if (opts.throwMessage) {
        return Promise.reject(new Error(opts.throwMessage))
      }
      const record: PendingRequestRecord = {
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: opts.requestStatus ?? 'done',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }
      if (opts.requestError) record.error = opts.requestError
      return Promise.resolve(record)
    },
  } as unknown as DaemonCell

  return {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([SERVER_ID]),
    getSnapshots: () =>
      Promise.resolve(
        new Map([
          [
            SERVER_ID,
            {
              serverId: SERVER_ID,
              version: 1,
              updatedAt: '2020-01-01T00:00:00.000Z',
              connected: opts.connected ?? true,
            },
          ],
        ]),
      ),
    purge: () => Promise.resolve(),
  }
}

async function createApp(opts: {
  db?: Db | null
  registry?: DaemonCellRegistry | null
} = {}) {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  const app = new Hono()
  app.use('*', async (c, next) => {
    const vars = c as unknown as Context<AppEnv>
    if (opts.db !== null) vars.set('db', opts.db ?? createDb([fleetRow()]))
    if (opts.registry !== null) {
      vars.set('daemonCellRegistry', opts.registry ?? createRegistry())
    }
    await next()
  })
  registerTunnelRoutes(app, { secrets, authRequired: false })
  return app
}

test('parseTunnelTokenBody requires a string token', () => {
  assertEquals(parseTunnelTokenBody(null).ok, false)
  assertEquals(parseTunnelTokenBody({}).ok, false)
  assertEquals(parseTunnelTokenBody({ token: 1 }).ok, false)
  assertEquals(parseTunnelTokenBody({ token: '' }), { ok: true, token: '' })
})

test('POST /instance/tunnel-token validates body and required context', async () => {
  const app = await createApp()
  const bad = await app.request(`${DEVELOPER_API_PREFIX}/instance/tunnel-token`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  })
  assertEquals(bad.status, 400)

  const noDb = await createApp({ db: null })
  const missingDb = await noDb.request(
    `${DEVELOPER_API_PREFIX}/instance/tunnel-token`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'tok' }) },
  )
  assertEquals(missingDb.status, 503)

  const noRegistry = await createApp({ registry: null })
  const missingRegistry = await noRegistry.request(
    `${DEVELOPER_API_PREFIX}/instance/tunnel-token`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'tok' }) },
  )
  assertEquals(missingRegistry.status, 503)
})

test('POST /instance/tunnel-token maps colocated and request outcomes', async () => {
  const missingColocated = await createApp({ db: createDb([]) })
  const none = await missingColocated.request(
    `${DEVELOPER_API_PREFIX}/instance/tunnel-token`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'tok' }) },
  )
  assertEquals(none.status, 503)

  const disconnected = await createApp({
    registry: createRegistry({ connected: false }),
  })
  const offline = await disconnected.request(
    `${DEVELOPER_API_PREFIX}/instance/tunnel-token`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'tok' }) },
  )
  assertEquals(offline.status, 503)

  const okApp = await createApp()
  const ok = await okApp.request(`${DEVELOPER_API_PREFIX}/instance/tunnel-token`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: 'tok' }),
  })
  assertEquals(ok.status, 200)

  const failedApp = await createApp({
    registry: createRegistry({ requestStatus: 'failed', requestError: 'nope' }),
  })
  const failed = await failedApp.request(
    `${DEVELOPER_API_PREFIX}/instance/tunnel-token`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'tok' }) },
  )
  assertEquals(failed.status, 500)

  const expiredApp = await createApp({
    registry: createRegistry({ requestStatus: 'expired' }),
  })
  const expired = await expiredApp.request(
    `${DEVELOPER_API_PREFIX}/instance/tunnel-token`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'tok' }) },
  )
  assertEquals(expired.status, 500)

  const throwApp = await createApp({
    registry: createRegistry({ throwMessage: 'cell down' }),
  })
  const thrown = await throwApp.request(
    `${DEVELOPER_API_PREFIX}/instance/tunnel-token`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'tok' }) },
  )
  assertEquals(thrown.status, 500)
})
