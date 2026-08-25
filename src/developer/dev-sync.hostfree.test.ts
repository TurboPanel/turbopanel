import { assertEquals } from '@std/assert'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../app.ts'
import type { DaemonCell, DaemonCellRegistry } from '../daemon/cell/contracts.ts'
import type { Db } from '../db.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../client/authn/secrets.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import {
  COLOCATED_DEV_SYNC_SKIPPED_REASON,
  isManagedDaemonDevSyncRefusal,
  MANAGED_DAEMON_DEV_SYNC_MARKER,
  MANAGED_DAEMON_DEV_SYNC_SKIPPED_REASON,
  registerDevSyncRoutes,
} from './dev-sync.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-4000-8000-0000000000d1'

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

function createDb(projectionRows: unknown[] = []): Db {
  return {
    select: (fields?: Record<string, unknown>) => {
      const keys = fields ? Object.keys(fields) : []
      const isProjection = keys.includes('daemon') && keys.includes('connected')
      return thenable(isProjection ? projectionRows : [])
    },
  } as unknown as Db
}

function directProjectionRow() {
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
    connected: true,
    statusChangedAt: '2020-01-01T00:00:00.000Z',
  }
}

function createRegistry(opts: {
  onlineIds?: string[]
  connected?: boolean
  syncError?: string
} = {}): DaemonCellRegistry {
  const cell = {
    enqueue: () => Promise.resolve({}),
    waitForRequest: () => Promise.resolve({ status: 'done' }),
  } as unknown as DaemonCell

  return {
    getCell: () => {
      if (opts.syncError) {
        return {
          enqueue: () => Promise.reject(new Error(opts.syncError)),
          waitForRequest: () => Promise.resolve(null),
        } as unknown as DaemonCell
      }
      return cell
    },
    listOnlineServerIds: () => Promise.resolve(opts.onlineIds ?? [SERVER_ID]),
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
    if (opts.db !== null) vars.set('db', opts.db ?? createDb())
    if (opts.registry !== null) {
      vars.set('daemonCellRegistry', opts.registry ?? createRegistry())
    }
    await next()
  })
  registerDevSyncRoutes(app, { secrets, authRequired: false })
  return app
}

test('isManagedDaemonDevSyncRefusal matches the daemon marker only', () => {
  assertEquals(
    isManagedDaemonDevSyncRefusal(`failed: ${MANAGED_DAEMON_DEV_SYNC_MARKER}`),
    true,
  )
  assertEquals(isManagedDaemonDevSyncRefusal('daemon not connected'), false)
})

test('POST /daemon/:id/sync-dev skips colocated and reports 503 without registry', async () => {
  const noRegistry = await createApp({ registry: null })
  const missing = await noRegistry.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: 'POST' },
  )
  assertEquals(missing.status, 503)

  const app = await createApp({
    db: createDb([directProjectionRow()]),
    registry: createRegistry(),
  })
  const skipped = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: 'POST' },
  )
  assertEquals(skipped.status, 422)
  const body = await skipped.json() as { error: string }
  assertEquals(body.error, COLOCATED_DEV_SYNC_SKIPPED_REASON)
})

test('POST /daemon/:id/sync-dev classifies managed refusal as skipped', async () => {
  const app = await createApp({
    registry: createRegistry({
      syncError: `apply failed: ${MANAGED_DAEMON_DEV_SYNC_MARKER}`,
    }),
  })
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: 'POST' },
  )
  assertEquals(response.status, 200)
  const body = await response.json() as { skipped?: boolean; error?: string }
  assertEquals(body.skipped, true)
  assertEquals(body.error, MANAGED_DAEMON_DEV_SYNC_SKIPPED_REASON)
})

test('POST /daemon/:id/sync-dev maps disconnected to 404', async () => {
  const app = await createApp({
    registry: createRegistry({ connected: false }),
  })
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/daemon/${SERVER_ID}/sync-dev`,
    { method: 'POST' },
  )
  assertEquals(response.status, 404)
})

test('POST /daemon/sync-dev skips colocated members of the fleet', async () => {
  const noRegistry = await createApp({ registry: null })
  const missing = await noRegistry.request(
    `${DEVELOPER_API_PREFIX}/daemon/sync-dev`,
    { method: 'POST' },
  )
  assertEquals(missing.status, 503)

  const app = await createApp({
    db: createDb([directProjectionRow()]),
    registry: createRegistry({ onlineIds: [SERVER_ID] }),
  })
  const response = await app.request(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, {
    method: 'POST',
  })
  assertEquals(response.status, 200)
  const body = await response.json() as {
    ok: boolean
    results: Array<{ skipped?: boolean; error?: string }>
  }
  assertEquals(body.ok, true)
  assertEquals(body.results[0]?.skipped, true)
  assertEquals(body.results[0]?.error, COLOCATED_DEV_SYNC_SKIPPED_REASON)
})
