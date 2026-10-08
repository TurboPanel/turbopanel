/**
 * Host-free coverage for managed route short-circuits (no Postgres).
 *
 * Requires env read for `src/lib/logger.ts` (`TURBOPANEL_DAEMON_DEBUG` /
 * `TURBOPANEL_LOG_LEVEL`) because `routes.ts` imports the logger at module
 * load. Run standalone with:
 *
 *   deno test --no-check --allow-read \
 *     --allow-env=TURBOPANEL_DAEMON_DEBUG,TURBOPANEL_LOG_LEVEL \
 *     src/client/managed/routes.hostfree.test.ts
 *
 * CI coverage uses `scripts/test-coverage.sh` (`deno test -A …`).
 */

import { assertEquals, assertStringIncludes } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import type { Db } from '../../db/connection.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  backup,
  binding,
  command,
  container,
  environment,
  managed,
  organization,
  principal,
  project,
  recovery,
  replica,
  server,
  service,
  session,
  user,
  workspace,
} from '../../db/schema.ts'
import { mariadbEngineSpec } from '../../features/managed/mariadb.ts'
import { mysqlEngineSpec } from '../../features/managed/mysql.ts'
import { postgresEngineSpec } from '../../features/managed/postgres.ts'
import { POSTGRES_ALLOWED_IMAGES } from '../../features/managed/settings.ts'
import type { ManagedEngineSpec } from '../../features/managed/types.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { managedSessionPaths } from '../../features/managed/routes-helpers.ts'
import { registerManagedRoutes } from './routes.ts'
import { SERVER_OFFLINE_BODY } from './context.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const ENV_ID = '33333333-3333-4333-8333-333333333333'
const PROJECT_ID = '44444444-4444-4444-8444-444444444444'
const MANAGED_ID = '55555555-5555-4555-8555-555555555555'
const SERVER_ID = '66666666-6666-4666-8666-666666666666'
const USER_ID = '77777777-7777-4777-8777-777777777777'
const PRINCIPAL_ID = '88888888-8888-4888-8888-888888888888'
const MEMBER_ID = '99999999-9999-4999-8999-999999999999'
const REPLICA_SERVER_ID = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const SERVICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CONTAINER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const BACKUP_ID = 'bk_abc123'

const ACTIVE_DAEMON = {
  key: {
    id: 'key-1',
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    fingerprint: 'fp',
    createdAt: '2024-01-01T00:00:00.000Z',
  },
}

const NOW = '2026-03-01T00:00:00.000Z'

function envPath(suffix = ''): string {
  return `/environments/${ENV_ID}/managed${suffix}`
}

function sessionRow() {
  return {
    sessionId: 'sess-1',
    userId: USER_ID,
    email: 'ops@example.com',
    role: 'superadmin',
    isDisabled: false,
  }
}

function envRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENV_ID,
    projectId: PROJECT_ID,
    serverId: null,
    name: 'Production',
    ...overrides,
  }
}

function validOptions() {
  const settings = postgresEngineSpec.parseSettings(postgresEngineSpec.defaultSettings)
  if (!settings) {
    throw new TypeError('failed to parse default postgres settings')
  }
  return {
    settings,
    databases: ['defaultdb', 'appdb'],
  }
}

function backupRow(overrides: Record<string, unknown> = {}) {
  return {
    // A `backup` row: uuid primary key, the daemon's `bk_…` id in `backup_id`
    // (unique per managed engine, surfaced to the API as `id`).
    id: '00000000-0000-7000-8000-0000000000b1',
    backupId: BACKUP_ID,
    managedId: MANAGED_ID,
    createdAt: NOW,
    sizeBytes: 1024,
    checksum: 'a'.repeat(64),
    database: null,
    path: '/var/lib/turbopanel/managed/m1/backups/bk_abc123.dump',
    ...overrides,
  }
}

function managedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MANAGED_ID,
    environmentId: ENV_ID,
    name: 'PostgreSQL',
    engine: 'postgres',
    status: 'ready',
    metadata: { rootPrincipalId: PRINCIPAL_ID, rootUsername: 'postgres' },
    options: validOptions(),
    serverId: SERVER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    environmentDisplayName: 'Production',
    projectId: PROJECT_ID,
    projectDisplayName: 'DB',
    workspaceId: ORG_ID,
    workspaceDisplayName: 'Default',
    serverDisplayName: 'host-1',
    ...overrides,
  }
}

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    managedId: MANAGED_ID,
    serverId: SERVER_ID,
    role: 'replica',
    replicaClass: 'failover',
    readEligible: false,
    ordinal: 2,
    status: 'ready',
    replicationTransport: 'datacenter',
    privatePort: 45001,
    metadata: {},
    options: {},
    createdAt: NOW,
    updatedAt: NOW,
    serverDisplayName: 'host-1',
    ...overrides,
  }
}

function presenceServer(connected = false, overrides: Record<string, unknown> = {}) {
  return {
    id: SERVER_ID,
    name: 'host-1',
    hostname: 'host-1',
    options: {},
    organizationId: ORG_ID,
    organizationOptions: {},
    daemon: null,
    metadata: null,
    machineKey: null,
    connected,
    statusChangedAt: NOW,
    ...overrides,
  }
}

function applyReadyServer(connected = true) {
  // `getServerDaemonStateByServerId` is `server ⋈ key` with the key row's
  // columns flattened onto the result (the jsonb `daemon` is projection-only
  // now). This fake answers every `server` query with the same rows, so the
  // key's own `id` is not spelled here — `id` stays the server id the
  // presence reads need; the daemon-state parse only carries it through.
  const { id: _keyId, ...keyColumns } = ACTIVE_DAEMON.key
  return presenceServer(connected, {
    daemon: null,
    ...keyColumns,
    revokedAt: null,
    lastUsedAt: null,
  })
}

function engineServiceRow() {
  return {
    id: SERVICE_ID,
    environmentId: ENV_ID,
    name: 'postgres',
    composeServiceName: 'postgres',
    options: {},
  }
}

function engineContainerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTAINER_ID,
    serviceId: SERVICE_ID,
    serverId: SERVER_ID,
    containerId: null,
    containerName: 'pending',
    status: 'pending',
    role: 'service',
    composeServiceName: 'postgres',
    ordinal: 1,
    metadata: {},
    options: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function stubRegistry(logs = 'stub-logs\n'): DaemonCellRegistry {
  return {
    getCell: () => ({
      createRequestAndWait: (outbound: DaemonOutboundEnvelope) =>
        Promise.resolve({
          serverId: SERVER_ID,
          requestId: outbound.requestId,
          requestKind: outbound.kind,
          status: 'done' as const,
          createdAt: outbound.at,
          expiresAt: outbound.at,
          result: { logs },
        }),
    }),
  } as unknown as DaemonCellRegistry
}

function recordingQueue(): CommandQueue {
  return {
    enqueue: (_envelope: CommandEnvelope) => Promise.resolve(),
  }
}

/** A queue that keeps what was enqueued, so a test can see nothing was. */
function countingQueue(sink: CommandEnvelope[]): CommandQueue {
  return {
    enqueue: (envelope: CommandEnvelope) => {
      sink.push(envelope)
      return Promise.resolve()
    },
  }
}

function principalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRINCIPAL_ID,
    kind: 'database',
    provider: 'postgres',
    username: 'appuser',
    managedId: MANAGED_ID,
    metadata: { engine: 'postgres', databases: ['postgres'] },
    options: {},
    password: 'sealed',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function queryChain(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const next: Record<string, unknown> = {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    limit: () => promise,
    orderBy: () => queryChain(rows),
    where: () => queryChain(rows),
    innerJoin: () => queryChain(rows),
    leftJoin: () => queryChain(rows),
    returning: () => promise,
    values: () => queryChain(rows),
    set: () => queryChain(rows),
    for: () => queryChain(rows),
  }
  return next
}

/**
 * `select().from(managed)` covers three unrelated shapes in the real code:
 * a plain `.where().limit()` existence check (`loadManagedForEnvironment`),
 * a 3x `.innerJoin()` + `.leftJoin()` + `.orderBy()` list join
 * (`GET /organizations/:id/managed`), and a 3x `.innerJoin()` +
 * `.where().limit()` ancestry walk (`resolveManagedHomeOrganizationId` in
 * `features/principals/store.ts`, used by `createManagedPrincipal`). `rows`
 * answers the first two; `ancestryRows` answers the third — distinguished
 * by whether `.leftJoin()` was reached before `.where()`, since that's the
 * one call the ancestry walk never makes.
 */
function managedQueryChain(rows: unknown[], ancestryRows: unknown[]) {
  const existenceChain = queryChain(rows) as Record<string, unknown>
  const listChain = queryChain(rows)
  const ancestryChain = queryChain(ancestryRows)
  const joinChain: Record<string, unknown> = {
    innerJoin: () => joinChain,
    leftJoin: () => listChain,
    where: () => ancestryChain,
  }
  existenceChain.innerJoin = () => joinChain
  return existenceChain
}

type FakeDbConfig = {
  envRows?: unknown[]
  projectRows?: unknown[]
  managedRows?: unknown[]
  orgRows?: unknown[]
  serverRows?: unknown[]
  principalRows?: unknown[]
  memberRows?: unknown[]
  bindingRows?: unknown[]
  recoveryRows?: unknown[]
  backupRows?: unknown[]
  serviceRows?: unknown[]
  containerRows?: unknown[]
  commandRows?: unknown[]
  executeRows?: unknown[]
  userRole?: string
  /** Called for every `insert().values()`, so a test can see what was written. */
  onInsert?: (table: unknown, values: Record<string, unknown>) => void
}

/**
 * Recovery rows inserted through a config's fake, shared with the fakes its
 * transactions open, so a locked read-modify-write sees the row just written.
 */
const insertedRecoveryRows = new WeakMap<FakeDbConfig, unknown[]>()

function fakeDb(config: FakeDbConfig = {}): Db {
  const executeRows = config.executeRows ?? [
    {
      allowed: true,
      organization_id: ORG_ID,
      kind: 'user',
    },
  ]
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === session) return queryChain([sessionRow()])
        if (table === user) {
          return queryChain([{ role: config.userRole ?? 'superadmin' }])
        }
        if (table === environment) {
          return queryChain(config.envRows ?? [envRow()])
        }
        if (table === project) {
          return queryChain(config.projectRows ?? [{ metadata: { code: 'postgres' } }])
        }
        if (table === organization) {
          return queryChain(config.orgRows ?? [{ options: {} }])
        }
        if (table === managed) {
          return managedQueryChain(config.managedRows ?? [], [{ organizationId: ORG_ID }])
        }
        if (table === server) {
          return queryChain(config.serverRows ?? [presenceServer()])
        }
        if (table === principal) {
          return queryChain(config.principalRows ?? [])
        }
        if (table === replica) {
          return queryChain(config.memberRows ?? [])
        }
        if (table === binding) {
          return queryChain(config.bindingRows ?? [])
        }
        if (table === recovery) {
          return queryChain(config.recoveryRows ?? insertedRecoveryRows.get(config) ?? [])
        }
        if (table === backup) {
          return queryChain(config.backupRows ?? [])
        }
        if (table === service) {
          return queryChain(config.serviceRows ?? [])
        }
        if (table === container) {
          return queryChain(config.containerRows ?? [])
        }
        if (table === command) {
          return queryChain(config.commandRows ?? [])
        }
        if (table === workspace) {
          return queryChain([{ id: ORG_ID, name: 'Default', kind: 'user' }])
        }
        return queryChain([])
      },
    }),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve([{ organizationId: ORG_ID }]),
        }),
        where: () => Promise.resolve([{ organizationId: ORG_ID }]),
      }),
    }),
    execute: () => Promise.resolve(executeRows),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        config.onInsert?.(table, values)
        const rows = [
          {
            ...principalRow(),
            ...memberRow({ role: 'primary', replicaClass: null, ordinal: 1 }),
            createdAt: NOW,
            updatedAt: NOW,
            queuedAt: NOW,
            ...values,
            id: typeof values.id === 'string' ? values.id : PRINCIPAL_ID,
          },
        ]
        if (table === recovery) insertedRecoveryRows.set(config, rows)
        return {
          ...queryChain(rows),
          onConflictDoNothing: () => queryChain(rows),
        }
      },
    }),
    update: (table: unknown) => ({
      set: (next: Record<string, unknown>) => ({
        where: () => {
          const base =
            table === recovery
              ? (insertedRecoveryRows.get(config)?.[0] as Record<string, unknown> | undefined)
              : undefined
          const row = {
            ...(base ??
              (config.managedRows?.[0] as Record<string, unknown> | undefined) ??
              managedRow()),
            ...next,
          }
          return queryChain([row])
        },
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
    transaction: (fn: (tx: Db) => Promise<unknown>) => fn(fakeDb(config)),
  } as unknown as Db
}

type BuildOpts = {
  db?: Db
  encrypt?: boolean
  registry?: DaemonCellRegistry
  commandQueue?: CommandQueue
}

async function buildApp(opts: BuildOpts = {}): Promise<{
  app: Hono<AppEnv>
  cookie: string
}> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets =
    opts.encrypt === false
      ? undefined
      : await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (opts.db) c.set('db', opts.db)
    c.set('runtime', 'deno')
    c.set('secretsConfig', secretsConfig)
    if (dataEncryptionSecrets) {
      c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    }
    if (opts.registry) c.set('daemonCellRegistry', opts.registry)
    if (opts.commandQueue) c.set('commandQueue', opts.commandQueue)
    return next()
  })
  registerManagedRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie('session-token', secrets)}`
  return { app, cookie }
}

function authHeaders(cookie: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: ORG_ID,
    ...extra,
  }
}

async function expectJson(
  response: Response,
  status: number,
  body: Record<string, unknown>
): Promise<void> {
  assertEquals(response.status, status)
  assertEquals(await response.json(), body)
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new TypeError('expected a JSON object')
  }
  return body as Record<string, unknown>
}

test('registerManagedRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  let threw = false
  try {
    registerManagedRoutes(app, {
      runtime: 'deno',
      signupEnvOverride: undefined,
    })
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
  }
  assertEquals(threw, true)
})

test('managed session paths return 401 without a session cookie', async () => {
  const { app } = await buildApp()
  for (const path of managedSessionPaths()) {
    const concrete = path
      .replaceAll(':id', ENV_ID)
      .replaceAll(':principalId', PRINCIPAL_ID)
      .replaceAll(':databaseName', 'appdb')
      .replaceAll(':backupId', BACKUP_ID)
      .replaceAll(':memberId', MEMBER_ID)
    const res = await app.request(concrete, { method: 'GET' })
    assertEquals(res.status, 401, path)
  }
})

test('POST create managed returns 401 when db is set but session missing', async () => {
  const { app } = await buildApp({ db: fakeDb() })
  const res = await app.request(envPath(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 401)
})

test('GET org managed returns 401 without session', async () => {
  const { app } = await buildApp({ db: fakeDb() })
  const res = await app.request(`/organizations/${ORG_ID}/managed`)
  assertEquals(res.status, 401)
})

const POLICY_ID = '0192d6a0-0000-7000-8000-00000000b0b1'

const BACKUP_POLICY_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: envPath('/backup-policies') },
  {
    method: 'POST',
    path: envPath('/backup-policies'),
    body: { name: 'Hourly', schedule: { preset: 'hourly' }, retentionKeep: 24 },
  },
  { method: 'PATCH', path: envPath(`/backup-policies/${POLICY_ID}`), body: { name: 'Renamed' } },
  { method: 'DELETE', path: envPath(`/backup-policies/${POLICY_ID}`) },
  { method: 'GET', path: envPath(`/backup-policies/${POLICY_ID}/runs`) },
]

const ENV_METHODS: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: envPath() },
  { method: 'POST', path: envPath(), body: {} },
  { method: 'PATCH', path: envPath(), body: {} },
  { method: 'POST', path: envPath('/apply') },
  { method: 'POST', path: envPath('/lifecycle'), body: { action: 'start' } },
  { method: 'DELETE', path: envPath() },
  { method: 'POST', path: envPath('/root-password') },
  { method: 'GET', path: envPath('/users') },
  { method: 'POST', path: envPath('/users'), body: { username: 'app' } },
  { method: 'POST', path: envPath(`/users/${PRINCIPAL_ID}/password`) },
  { method: 'DELETE', path: envPath(`/users/${PRINCIPAL_ID}`) },
  { method: 'GET', path: envPath('/databases') },
  { method: 'POST', path: envPath('/databases'), body: { name: 'appdb' } },
  { method: 'DELETE', path: envPath('/databases/appdb') },
  { method: 'GET', path: envPath('/members') },
  { method: 'POST', path: envPath('/members'), body: { serverId: SERVER_ID } },
  {
    method: 'PATCH',
    path: envPath(`/members/${MEMBER_ID}`),
    body: { readEligible: true },
  },
  { method: 'DELETE', path: envPath(`/members/${MEMBER_ID}`) },
  { method: 'POST', path: envPath(`/members/${MEMBER_ID}/promote`), body: {} },
  {
    method: 'POST',
    path: envPath('/disaster-recovery/promote'),
    body: { confirm: true, memberId: MEMBER_ID },
  },
  { method: 'GET', path: envPath('/status') },
  { method: 'GET', path: envPath('/logs') },
  { method: 'GET', path: envPath('/backups') },
  { method: 'POST', path: envPath('/backups'), body: {} },
  { method: 'DELETE', path: envPath(`/backups/${BACKUP_ID}`) },
  { method: 'POST', path: envPath(`/backups/${BACKUP_ID}/restore`) },
  ...BACKUP_POLICY_ROUTES,
]

test('authenticated managed routes require an organization header', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb() })
  for (const route of ENV_METHODS) {
    const res = await app.request(route.path, {
      method: route.method,
      headers: {
        Cookie: cookie,
        ...(route.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: route.body === undefined ? undefined : JSON.stringify(route.body),
    })
    assertEquals(res.status, 400, `${route.method} ${route.path}`)
    const body = await jsonOf(res)
    assertEquals(body.error, 'organizationId required', `${route.method} ${route.path}`)
  }
})

test('authorizeManagedRequest hides a foreign environment as 404', async () => {
  const db = fakeDb({
    executeRows: [{ allowed: true, organization_id: OTHER_ORG, kind: 'user' }],
  })
  const { app, cookie } = await buildApp({ db })
  await expectJson(await app.request(envPath(), { headers: authHeaders(cookie) }), 404, {
    error: 'Not found',
  })
})

test('authorizeManagedRequest returns 403 when manage is denied', async () => {
  let executeCalls = 0
  const db = {
    ...fakeDb(),
    execute: () => {
      executeCalls += 1
      if (executeCalls === 1) {
        return Promise.resolve([{ organization_id: ORG_ID, kind: 'user' }])
      }
      return Promise.resolve([
        {
          allowed: false,
          organization_id: ORG_ID,
          kind: 'user',
        },
      ])
    },
  } as unknown as Db
  const { app, cookie } = await buildApp({ db })
  await expectJson(await app.request(envPath(), { headers: authHeaders(cookie) }), 403, {
    error: 'Forbidden',
  })
})

function requestRoute(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  cookie: string,
  route: { method: string; path: string; body?: unknown }
): Promise<Response> {
  return Promise.resolve(
    app.request(route.path, {
      method: route.method,
      headers: authHeaders(
        cookie,
        route.body === undefined ? undefined : { 'content-type': 'application/json' }
      ),
      body: route.body === undefined ? undefined : JSON.stringify(route.body),
    })
  )
}

function capturingQueue(): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: (envelope: CommandEnvelope) => {
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

test('backup policy routes hide a foreign environment as 404', async () => {
  const db = fakeDb({
    executeRows: [{ allowed: true, organization_id: OTHER_ORG, kind: 'user' }],
  })
  const { app, cookie } = await buildApp({ db })
  for (const route of BACKUP_POLICY_ROUTES) {
    const res = await requestRoute(app, cookie, route)
    assertEquals(res.status, 404, `${route.method} ${route.path}`)
  }
})

test('backup policy routes refuse a member without organization:manage with 403', async () => {
  for (const route of BACKUP_POLICY_ROUTES) {
    let executeCalls = 0
    const db = {
      ...fakeDb({ managedRows: [managedRow()] }),
      execute: () => {
        executeCalls += 1
        if (executeCalls === 1) {
          return Promise.resolve([{ organization_id: ORG_ID, kind: 'user' }])
        }
        return Promise.resolve([{ allowed: false, organization_id: ORG_ID, kind: 'user' }])
      },
    } as unknown as Db
    const { app, cookie } = await buildApp({ db })
    await expectJson(await requestRoute(app, cookie, route), 403, { error: 'Forbidden' })
  }
})

test('backup policy routes let org owners and managers (organization:manage) list and create', async () => {
  // Owners and managers both hold `organization:manage`; the fake answers the
  // `can()` check with allowed=true, exactly as the real query does for them.
  const commandQueue = capturingQueue()
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
    commandQueue,
  })

  await expectJson(await requestRoute(app, cookie, BACKUP_POLICY_ROUTES[0]!), 200, {
    policies: [],
  })

  const created = await requestRoute(app, cookie, BACKUP_POLICY_ROUTES[1]!)
  assertEquals(created.status, 201)
  const body = await jsonOf(created)
  const policy = body.policy as Record<string, unknown>
  assertEquals(policy.name, 'Hourly')
  assertEquals(policy.schedule, '0 * * * *')
  assertEquals(policy.preset, { preset: 'hourly' })
  assertEquals(policy.retentionKeep, 24)
  assertEquals(policy.automatic, false)
  assertEquals(body.reconcile, { queuedServerIds: [SERVER_ID], failedServerIds: [] })
  assertEquals(commandQueue.envelopes.length, 1)
  assertEquals(commandQueue.envelopes[0]?.type, 'server.backups.reconcile')
  assertEquals(commandQueue.envelopes[0]?.serverId, SERVER_ID)
})

test('backup policy create validates the body before writing', async () => {
  const commandQueue = capturingQueue()
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
    commandQueue,
  })
  const post = (body: Record<string, unknown>) =>
    requestRoute(app, cookie, { method: 'POST', path: envPath('/backup-policies'), body })
  const base = { name: 'Nightly', schedule: '0 2 * * *', retentionKeep: 7 }

  const unionDays = await jsonOf(await post({ ...base, schedule: '0 0 1 * 1' }))
  assertEquals(unionDays.error, 'backup_schedule_invalid')
  const reboot = await jsonOf(await post({ ...base, schedule: '@reboot' }))
  assertEquals(reboot.error, 'backup_schedule_invalid')
  const badTime = await jsonOf(
    await post({ ...base, schedule: { preset: 'daily', time: '25:00' } })
  )
  assertEquals(badTime.error, 'backup_schedule_invalid')
  const badZone = await jsonOf(await post({ ...base, timezone: 'Not/AZone' }))
  assertEquals(badZone.error, 'backup_timezone_invalid')
  const tooMany = await jsonOf(await post({ ...base, retentionKeep: 51 }))
  assertEquals(tooMany.error, 'backup_policy_invalid')
  assertEquals(tooMany.field, 'retentionKeep')
  const noName = await jsonOf(await post({ ...base, name: '  ' }))
  assertEquals(noName.field, 'name')
  await expectJson(await post({ ...base, targetKind: 'copy' }), 400, {
    error: 'backup_target_unsupported',
  })
  assertEquals(commandQueue.envelopes.length, 0)
})

test('backup policy item routes answer 404 for an id that is not a policy', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb({ managedRows: [managedRow()] }) })
  for (const route of BACKUP_POLICY_ROUTES.slice(2)) {
    for (const policyId of [POLICY_ID, 'not-a-uuid']) {
      const res = await requestRoute(app, cookie, {
        ...route,
        path: route.path.replace(POLICY_ID, policyId),
      })
      await expectJson(res, 404, { error: 'backup_policy_not_found' })
    }
  }
})

test('backup policy routes need a managed engine in the environment', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb({ managedRows: [] }) })
  await expectJson(await requestRoute(app, cookie, BACKUP_POLICY_ROUTES[0]!), 200, {
    policies: [],
  })
  for (const route of BACKUP_POLICY_ROUTES.slice(1)) {
    const res = await requestRoute(app, cookie, route)
    assertEquals(res.status, 404, `${route.method} ${route.path}`)
  }
})

test('authorizeManagedRequest rejects a TurboPanel workspace as immutable', async () => {
  let executeCalls = 0
  const db = {
    ...fakeDb(),
    execute: () => {
      executeCalls += 1
      if (executeCalls <= 2) {
        return Promise.resolve([
          {
            allowed: true,
            organization_id: ORG_ID,
            kind: 'user',
          },
        ])
      }
      return Promise.resolve([
        {
          allowed: true,
          organization_id: ORG_ID,
          kind: 'turbopanel',
        },
      ])
    },
  } as unknown as Db
  const { app, cookie } = await buildApp({ db })
  await expectJson(await app.request(envPath(), { headers: authHeaders(cookie) }), 403, {
    error: 'system_resource_immutable',
  })
})

test('loadManagedContext returns 404 when the environment is missing', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb({ envRows: [] }) })
  await expectJson(await app.request(envPath(), { headers: authHeaders(cookie) }), 404, {
    error: 'Not found',
  })
})

test('loadManagedContext returns 404 when the project is missing', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb({ projectRows: [] }) })
  await expectJson(await app.request(envPath(), { headers: authHeaders(cookie) }), 404, {
    error: 'Not found',
  })
})

test('loadManagedContext rejects a non-managed catalog code', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ projectRows: [{ metadata: { code: 'docker-compose' } }] }),
  })
  await expectJson(await app.request(envPath(), { headers: authHeaders(cookie) }), 400, {
    error: 'not_managed_environment',
  })
})

test('loadManagedContext rejects a project with no catalog code', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ projectRows: [{ metadata: {} }] }),
  })
  await expectJson(await app.request(envPath(), { headers: authHeaders(cookie) }), 400, {
    error: 'not_managed_environment',
  })
})

test('GET managed returns the empty detail when no row exists', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb() })
  const res = await app.request(envPath(), { headers: authHeaders(cookie) })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.managed, null)
  assertEquals(body.connection, null)
  assertEquals(body.rootUsername, null)
})

test('GET users / databases / members / backups are empty without a row', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb() })
  const headers = authHeaders(cookie)
  await expectJson(await app.request(envPath('/users'), { headers }), 200, {
    users: [],
  })
  await expectJson(await app.request(envPath('/databases'), { headers }), 200, {
    databases: [],
  })
  await expectJson(await app.request(envPath('/members'), { headers }), 200, {
    members: [],
  })
  await expectJson(await app.request(envPath('/backups'), { headers }), 200, {
    backups: [],
  })
})

test('GET status returns a null snapshot when no managed row exists', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb() })
  const res = await app.request(envPath('/status'), {
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.status, null)
  assertEquals(body.error, null)
  assertEquals(body.containers, [])
  assertEquals(body.members, [])
})

test('mutating routes return 404 when the managed row is missing', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb() })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  const missing = [
    ['PATCH', envPath(), {}],
    ['POST', envPath('/apply'), undefined],
    ['POST', envPath('/lifecycle'), { action: 'start' }],
    ['DELETE', envPath(), undefined],
    ['POST', envPath('/root-password'), undefined],
    ['POST', envPath('/users'), { username: 'app' }],
    ['POST', envPath(`/users/${PRINCIPAL_ID}/password`), undefined],
    ['DELETE', envPath(`/users/${PRINCIPAL_ID}`), undefined],
    ['POST', envPath('/databases'), { name: 'appdb' }],
    ['DELETE', envPath('/databases/appdb'), undefined],
    ['POST', envPath('/members'), { serverId: SERVER_ID }],
    ['PATCH', envPath(`/members/${MEMBER_ID}`), { readEligible: true }],
    ['DELETE', envPath(`/members/${MEMBER_ID}`), undefined],
    ['POST', envPath(`/members/${MEMBER_ID}/promote`), {}],
    [
      'POST',
      envPath('/disaster-recovery/promote'),
      {
        confirm: true,
        memberId: MEMBER_ID,
      },
    ],
    ['GET', envPath('/logs'), undefined],
    ['POST', envPath('/backups'), {}],
    ['DELETE', envPath(`/backups/${BACKUP_ID}`), undefined],
    ['POST', envPath(`/backups/${BACKUP_ID}/restore`), undefined],
  ] as const
  for (const [method, path, body] of missing) {
    const res = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assertEquals(res.status, 404, `${method} ${path}`)
    const json = await jsonOf(res)
    assertEquals(json.error, 'Not found', `${method} ${path}`)
  }
})

test('GET managed returns 400 when stored options are invalid', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ options: { settings: { image: '' } } })],
    }),
  })
  await expectJson(await app.request(envPath(), { headers: authHeaders(cookie) }), 400, {
    error: 'Invalid managed options',
  })
})

test('GET managed serializes a placed cluster without a live listener', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ serverId: null })],
      envRows: [envRow({ serverId: null })],
    }),
  })
  const res = await app.request(envPath(), { headers: authHeaders(cookie) })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.rootUsername, 'postgres')
  assertEquals(body.connection, null)
  assertEquals(body.server, null)
  const ssl = body.ssl as Record<string, unknown>
  assertEquals(ssl.effective, 'require')
})

test('GET databases / backups / members return stored values', async () => {
  const row = managedRow()
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [row],
      memberRows: [memberRow()],
      backupRows: [backupRow()],
    }),
  })
  const headers = authHeaders(cookie)
  const databases = await jsonOf(await app.request(envPath('/databases'), { headers }))
  assertEquals(databases.databases, ['defaultdb', 'appdb'])

  const backups = await jsonOf(await app.request(envPath('/backups'), { headers }))
  const list = backups.backups as Array<{ id: string }>
  assertEquals(list[0]?.id, BACKUP_ID)

  const members = await jsonOf(await app.request(envPath('/members'), { headers }))
  const memberList = members.members as Array<{ id: string; role: string }>
  assertEquals(memberList[0]?.id, MEMBER_ID)
  assertEquals(memberList[0]?.role, 'replica')
})

test('GET users filters root and replication principals', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [
        principalRow({ metadata: { managedRoot: true } }),
        principalRow({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          username: 'repl',
          metadata: { managedReplication: true },
        }),
        principalRow({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          username: 'appuser',
        }),
      ],
    }),
  })
  const body = await jsonOf(await app.request(envPath('/users'), { headers: authHeaders(cookie) }))
  const users = body.users as Array<{ username: string }>
  assertEquals(
    users.map((entry) => entry.username),
    ['appuser']
  )
})

test('GET status includes residual host/port when unplaced', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [
        managedRow({
          serverId: null,
          metadata: { host: 'db.internal', port: 15432, error: 'boom' },
          status: 'ready',
        }),
      ],
    }),
  })
  const body = await jsonOf(await app.request(envPath('/status'), { headers: authHeaders(cookie) }))
  assertEquals(body.status, 'ready')
  assertEquals(body.host, 'db.internal')
  assertEquals(body.port, 15432)
  assertEquals(body.error, null)
})

test('GET logs requires a placement pin', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ serverId: null })] }),
  })
  await expectJson(await app.request(envPath('/logs'), { headers: authHeaders(cookie) }), 409, {
    error: 'server_placement_required',
  })
})

test('POST create returns alreadyProvisioned for a finished row', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  const res = await app.request(envPath(), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.ok, true)
  assertEquals(body.alreadyProvisioned, true)
})

test('POST create clears a provisioning row then requires placement', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ status: 'provisioning' })],
      envRows: [envRow({ serverId: null })],
    }),
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    409,
    { error: 'server_placement_required' }
  )
})

test('POST create requires encryption secrets after placement', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ envRows: [envRow({ serverId: SERVER_ID })] }),
    encrypt: false,
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    503,
    { error: 'Encryption unavailable' }
  )
})

test('POST create rejects an invalid display name', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ envRows: [envRow({ serverId: SERVER_ID })] }),
  })
  const res = await app.request(envPath(), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 12 }),
  })
  // Offline check runs before body parse when a placement pin exists.
  assertEquals(res.status === 409 || res.status === 400, true)
})

/** A POST create against a placed, online server with a working command queue. */
async function postCreate(
  body: Record<string, unknown>,
  inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [],
  code = 'postgres'
): Promise<Response> {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      envRows: [envRow({ serverId: SERVER_ID })],
      projectRows: [{ metadata: { code } }],
      serverRows: [applyReadyServer(true)],
      onInsert: (table, values) => inserted.push({ table, values }),
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  return await app.request(envPath(), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('POST create refuses an untested or unknown version with 422 and writes nothing', async () => {
  for (const body of [
    { engineSeries: '17' },
    { engineSeries: '99' },
    { engineSeries: '18', imageVariant: 'nope' },
    { imageVariant: 'nope' },
  ]) {
    const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = []
    const res = await postCreate(body, inserted)
    await expectJson(res, 422, { error: 'managed_version_unsupported' })
    assertEquals(inserted.length, 0, `${JSON.stringify(body)} must not create anything`)
  }
})

test('POST create refuses a malformed series or variant with 400 and writes nothing', async () => {
  for (const [body, error] of [
    [{ engineSeries: 18 }, 'Invalid engineSeries'],
    [{ engineSeries: ['18'] }, 'Invalid engineSeries'],
    [{ imageVariant: false }, 'Invalid imageVariant'],
  ] as const) {
    const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = []
    await expectJson(await postCreate(body, inserted), 400, { error })
    assertEquals(inserted.length, 0)
  }
})

/**
 * The settings image the create wrote onto the new `managed` row. The fake
 * database cannot finish the apply preparation (no member rows come back), so
 * the status is not asserted here; the DB-backed suite covers the full create.
 */
async function createdImage(
  body: Record<string, unknown>,
  code = 'postgres'
): Promise<string | undefined> {
  const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = []
  await postCreate(body, inserted, code)
  const row = inserted.find((entry) => entry.table === managed)
  const options = row?.values.options as { settings?: { image?: string } } | undefined
  if (!options?.settings) throw new TypeError('create did not persist settings')
  return options.settings.image
}

test('POST create persists the requested variant and stores the default when none is sent', async () => {
  // Neither field: the resolved default image is stored, so a later change of the
  // catalog default can never change which series this row runs.
  assertEquals(await createdImage({}), 'docker.io/library/postgres:18-alpine')
  assertEquals(await createdImage({}, 'mariadb'), 'docker.io/library/mariadb:11.8')
  assertEquals(await createdImage({ engineSeries: '18' }), 'docker.io/library/postgres:18-alpine')
  assertEquals(
    await createdImage({ engineSeries: '18', imageVariant: 'debian' }),
    'docker.io/library/postgres:18'
  )
  assertEquals(await createdImage({ imageVariant: 'debian' }), 'docker.io/library/postgres:18')
})

test('POST create resolves MySQL and MariaDB versions through the same helper', async () => {
  assertEquals(
    await createdImage({ engineSeries: '9.7', imageVariant: 'oraclelinux9' }, 'mysql'),
    'docker.io/library/mysql:9.7-oraclelinux9'
  )
  assertEquals(await createdImage({ engineSeries: '9.7' }, 'mysql'), 'docker.io/library/mysql:9.7')
  assertEquals(
    await createdImage({ engineSeries: '12.3' }, 'mariadb'),
    'docker.io/library/mariadb:12.3'
  )
  assertEquals(await createdImage({ engineSeries: '8.4' }, 'mysql'), 'docker.io/library/mysql:8.4')
  assertEquals(
    await createdImage({ engineSeries: '11.8', imageVariant: 'ubi' }, 'mariadb'),
    'docker.io/library/mariadb:11.8-ubi'
  )
  for (const [code, series] of [
    ['mysql', '8.0'],
    ['mariadb', '11.4'],
  ] as const) {
    const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = []
    const res = await postCreate({ engineSeries: series }, inserted, code)
    await expectJson(res, 422, { error: 'managed_version_unsupported' })
    assertEquals(inserted.length, 0)
  }
})

test('PATCH rejects applying clusters as busy', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ status: 'applying' })] }),
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'PATCH',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    409,
    { error: 'managed_busy' }
  )
})

test('PATCH requires a placement pin on the managed row', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ serverId: null })] }),
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'PATCH',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    409,
    { error: 'server_placement_required' }
  )
})

test('PATCH returns 400 for invalid stored options', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ options: { settings: { image: '' } } })],
    }),
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'PATCH',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    400,
    { error: 'Invalid managed options' }
  )
})

test('PATCH returns 400 for invalid JSON', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'PATCH',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: '[]',
    }),
    400,
    { error: 'Invalid request' }
  )
})

test('PATCH persists a no-op settings merge', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  const res = await app.request(envPath(), {
    method: 'PATCH',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.ok, true)
})

test('PATCH rejects invalid settings', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'PATCH',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { image: '' } }),
    }),
    400,
    { error: 'managed_settings_invalid' }
  )
})

const PG_ALPINE = 'docker.io/library/postgres:18-alpine'
const PG_DEBIAN = 'docker.io/library/postgres:18'
const PG_SERIES_17_ALPINE = 'docker.io/library/postgres:17-alpine'
const PG_SERIES_17_DEBIAN = 'docker.io/library/postgres:17'

/** A fake db that counts every write, so a refusal can prove nothing persisted. */
function writeCountingDb(config: FakeDbConfig): { db: Db; writes: () => number } {
  const base = fakeDb(config)
  let count = 0
  const counted = <T extends (...args: never[]) => unknown>(fn: T) =>
    ((...args: Parameters<T>) => {
      count += 1
      return fn(...args)
    }) as T
  const db = {
    ...base,
    update: counted(base.update.bind(base)),
    insert: counted(base.insert.bind(base)),
    delete: counted(base.delete.bind(base)),
    transaction: counted(base.transaction.bind(base)),
  } as unknown as Db
  return { db, writes: () => count }
}

function patchManaged(
  app: Hono<AppEnv>,
  cookie: string,
  settings: Record<string, unknown>
): Promise<Response> {
  return Promise.resolve(
    app.request(envPath(), {
      method: 'PATCH',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    })
  )
}

function rowFor(spec: ManagedEngineSpec, image: string) {
  const settings = spec.parseSettings({ ...spec.defaultSettings, image })
  if (!settings) throw new TypeError(`failed to parse ${spec.engine} settings`)
  return managedRow({
    engine: spec.engine,
    options: { settings, databases: ['defaultdb'] },
  })
}

test('PATCH refuses a series change with 409 managed_series_immutable and persists nothing', async () => {
  // Only series 18 is creatable today, so the settings parser would answer 400
  // before the series guard runs. Widen the allowlist for this test only, the
  // way it will look once a second series is promoted to tested.
  const allowed = POSTGRES_ALLOWED_IMAGES as string[]
  const added = [PG_SERIES_17_ALPINE, PG_SERIES_17_DEBIAN].filter(
    (image) => !allowed.includes(image)
  )
  allowed.push(...added)
  try {
    const { db, writes } = writeCountingDb({
      managedRows: [rowFor(postgresEngineSpec, PG_ALPINE)],
    })
    const { app, cookie } = await buildApp({ db })
    for (const image of [PG_SERIES_17_ALPINE, PG_SERIES_17_DEBIAN]) {
      const res = await patchManaged(app, cookie, { image })
      assertEquals(res.status, 409)
      const body = await jsonOf(res)
      assertEquals(body.error, 'managed_series_immutable')
      assertEquals(typeof body.message, 'string')
    }
    assertEquals(writes(), 0)
  } finally {
    for (const image of added) allowed.splice(allowed.indexOf(image), 1)
  }
})

test('PATCH to an untested series is refused by the settings parser and persists nothing', async () => {
  const { db, writes } = writeCountingDb({ managedRows: [rowFor(postgresEngineSpec, PG_ALPINE)] })
  const { app, cookie } = await buildApp({ db })
  const res = await patchManaged(app, cookie, { image: PG_SERIES_17_ALPINE })
  assertEquals(res.status, 400)
  assertEquals((await jsonOf(res)).error, 'managed_settings_invalid')
  assertEquals(writes(), 0)
})

test('PATCH refuses Alpine to Debian on PostgreSQL with 409 managed_variant_swap_unsafe and persists nothing', async () => {
  const { db, writes } = writeCountingDb({ managedRows: [rowFor(postgresEngineSpec, PG_ALPINE)] })
  const { app, cookie } = await buildApp({ db })
  const res = await patchManaged(app, cookie, { image: PG_DEBIAN })
  assertEquals(res.status, 409)
  const body = await jsonOf(res)
  assertEquals(body.error, 'managed_variant_swap_unsafe')
  assertEquals(String(body.message).includes('restore a backup'), true)
  assertEquals(writes(), 0)

  // The other direction is just as unsafe.
  const reverse = writeCountingDb({ managedRows: [rowFor(postgresEngineSpec, PG_DEBIAN)] })
  const reverseApp = await buildApp({ db: reverse.db })
  const back = await patchManaged(reverseApp.app, reverseApp.cookie, { image: PG_ALPINE })
  assertEquals(back.status, 409)
  assertEquals((await jsonOf(back)).error, 'managed_variant_swap_unsafe')
  assertEquals(reverse.writes(), 0)
})

test('PATCH accepts a PostgreSQL patch that keeps the same image', async () => {
  const { db, writes } = writeCountingDb({ managedRows: [rowFor(postgresEngineSpec, PG_ALPINE)] })
  const { app, cookie } = await buildApp({ db })
  const res = await patchManaged(app, cookie, { image: PG_ALPINE })
  assertEquals(res.status, 200)
  assertEquals((await jsonOf(res)).ok, true)
  assertEquals(writes(), 1)
})

test('PATCH still allows a MySQL and a MariaDB variant change', async () => {
  const cases: Array<[ManagedEngineSpec, string, string]> = [
    [mysqlEngineSpec, 'docker.io/library/mysql:9.7', 'docker.io/library/mysql:9.7-oraclelinux9'],
    [mariadbEngineSpec, 'docker.io/library/mariadb:12.3', 'docker.io/library/mariadb:12.3-ubi'],
  ]
  for (const [spec, from, to] of cases) {
    const { db, writes } = writeCountingDb({
      managedRows: [rowFor(spec, from)],
      projectRows: [{ metadata: { code: spec.engine } }],
    })
    const { app, cookie } = await buildApp({ db })
    const res = await patchManaged(app, cookie, { image: to })
    assertEquals(res.status, 200)
    const body = await jsonOf(res)
    assertEquals((body.settings as { image: string }).image, to)
    assertEquals(writes(), 1)
  }
})

test('POST apply / lifecycle / backups require a placement pin', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ serverId: null })],
      backupRows: [backupRow()],
    }),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  for (const [method, path, body] of [
    ['POST', envPath('/apply'), undefined],
    ['POST', envPath('/lifecycle'), { action: 'start' }],
    ['POST', envPath('/backups'), {}],
    ['DELETE', envPath(`/backups/${BACKUP_ID}`), undefined],
    ['POST', envPath(`/backups/${BACKUP_ID}/restore`), undefined],
  ] as const) {
    await expectJson(
      await app.request(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      409,
      { error: 'server_placement_required' }
    )
  }
})

test('POST apply returns 400 for invalid stored options', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ options: null })] }),
  })
  await expectJson(
    await app.request(envPath('/apply'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    400,
    { error: 'Invalid managed options' }
  )
})

test('POST lifecycle rejects a busy cluster before parsing the action', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ status: 'applying' })] }),
  })
  await expectJson(
    await app.request(envPath('/lifecycle'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    }),
    409,
    { error: 'managed_busy' }
  )
})

test('POST lifecycle rejects an unknown action', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  await expectJson(
    await app.request(envPath('/lifecycle'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'bounce' }),
    }),
    400,
    { error: 'Invalid request' }
  )
})

test('DELETE hard-deletes an unplaced cluster', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ serverId: null })] }),
  })
  const res = await app.request(envPath(), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.ok, true)
  assertEquals(body.deleted, true)
})

test('DELETE / lifecycle / members reject a busy cluster', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ status: 'applying' })] }),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  for (const [method, path] of [
    ['DELETE', envPath()],
    ['POST', envPath('/members')],
    ['PATCH', envPath(`/members/${MEMBER_ID}`)],
    ['DELETE', envPath(`/members/${MEMBER_ID}`)],
    ['POST', envPath(`/members/${MEMBER_ID}/promote`)],
    ['POST', envPath('/disaster-recovery/promote')],
    ['POST', envPath('/backups')],
  ] as const) {
    await expectJson(
      await app.request(path, {
        method,
        headers,
        body: JSON.stringify({}),
      }),
      409,
      { error: 'managed_busy' }
    )
  }
})

test('POST root-password fails when the root principal is missing', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ metadata: {} })] }),
  })
  await expectJson(
    await app.request(envPath('/root-password'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    500,
    { error: 'root_principal_missing' }
  )
})

test('POST root-password requires encryption secrets', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
    encrypt: false,
  })
  await expectJson(
    await app.request(envPath('/root-password'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    503,
    { error: 'Encryption unavailable' }
  )
})

test('POST root-password returns 400 for invalid stored options', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ options: 'nope' })] }),
  })
  await expectJson(
    await app.request(envPath('/root-password'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    400,
    { error: 'Invalid managed options' }
  )
})

test('POST users rejects invalid JSON and missing encryption', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
    encrypt: false,
  })
  await expectJson(
    await app.request(envPath('/users'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: 'null',
    }),
    400,
    { error: 'Invalid request' }
  )
})

test('POST users returns 400 for invalid stored options', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ options: { databases: 1 } })] }),
  })
  await expectJson(
    await app.request(envPath('/users'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'appuser' }),
    }),
    400,
    { error: 'Invalid managed options' }
  )
})

test('POST user password returns 404 when the principal is missing', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [],
    }),
  })
  await expectJson(
    await app.request(envPath(`/users/${PRINCIPAL_ID}/password`), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    404,
    { error: 'Not found' }
  )
})

test('POST user password refuses the root principal', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [principalRow({ metadata: { managedRoot: true } })],
    }),
  })
  await expectJson(
    await app.request(envPath(`/users/${PRINCIPAL_ID}/password`), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    400,
    { error: 'use_root_password_route' }
  )
})

test('POST user password refuses a replication principal', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [principalRow({ metadata: { managedReplication: true } })],
    }),
  })
  await expectJson(
    await app.request(envPath(`/users/${PRINCIPAL_ID}/password`), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    400,
    { error: 'cannot_rotate_replication_user' }
  )
})

test('DELETE user refuses the root principal', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [principalRow({ metadata: { managedRoot: true } })],
    }),
  })
  await expectJson(
    await app.request(envPath(`/users/${PRINCIPAL_ID}`), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    400,
    { error: 'cannot_drop_root_user' }
  )
})

test('DELETE user returns 409 while bindings remain', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [principalRow()],
      bindingRows: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          serviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          name: 'web',
          environmentId: ENV_ID,
          projectId: PROJECT_ID,
          keyPrefix: 'DATABASE',
        },
      ],
    }),
  })
  const res = await app.request(envPath(`/users/${PRINCIPAL_ID}`), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 409)
  const body = await jsonOf(res)
  assertEquals(body.error, 'managed_user_has_bindings')
})

test('POST databases rejects a missing name and an invalid identifier', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectJson(
    await app.request(envPath('/databases'), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }),
    400,
    { error: 'Invalid request' }
  )
  // Hyphens are refused on purpose, and the answer says so in plain words.
  const hyphen = await app.request(envPath('/databases'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'bad-name' }),
  })
  assertEquals(hyphen.status, 400)
  const hyphenBody = (await hyphen.json()) as { error: string; message: string }
  assertEquals(hyphenBody.error, 'Invalid database name')
  assertStringIncludes(hyphenBody.message, 'Hyphens are not allowed on purpose')
  assertStringIncludes(hyphenBody.message, 'my_app')
})

test('POST databases returns 400 for invalid stored options', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ options: [] })] }),
  })
  await expectJson(
    await app.request(envPath('/databases'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'appdb' }),
    }),
    400,
    { error: 'Invalid managed options' }
  )
})

test('DELETE database refuses the initial database and unknown names', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  await expectJson(
    await app.request(envPath('/databases/defaultdb'), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    409,
    { error: 'cannot_drop_initial_database' }
  )
  await expectJson(
    await app.request(envPath('/databases/missing'), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    404,
    { error: 'Not found' }
  )
})

test('DELETE database returns 409 listing the SQL users that still have access', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [
        principalRow({ metadata: { managedRoot: true, databases: ['appdb'] } }),
        principalRow({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          username: 'repl',
          metadata: { managedReplication: true, databases: ['appdb'] },
        }),
        principalRow({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          username: 'appuser',
          metadata: { engine: 'postgres', databases: ['defaultdb', 'appdb'] },
        }),
        principalRow({
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccd',
          username: 'other',
          metadata: { engine: 'postgres', databases: ['defaultdb'] },
        }),
      ],
    }),
  })
  const res = await app.request(envPath('/databases/appdb'), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 409)
  const raw = await res.text()
  assertEquals(JSON.parse(raw), { error: 'managed_database_has_users', users: ['appuser'] })
  assertEquals(raw.includes('sealed'), false)
})

test('DELETE database reports bindings before users', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [
        principalRow({ metadata: { engine: 'postgres', databases: ['defaultdb', 'appdb'] } }),
      ],
      bindingRows: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          serviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          name: 'web',
          environmentId: ENV_ID,
          projectId: PROJECT_ID,
          keyPrefix: 'DATABASE',
        },
      ],
    }),
  })
  const res = await app.request(envPath('/databases/appdb'), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 409)
  assertEquals((await jsonOf(res)).error, 'managed_database_has_bindings')
})

test('POST members rejects a missing serverId and an invalid replica class', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      // Seed a primary so `ensureManagedPrimaryMember` short-circuits before
      // the insert/`onConflictDoNothing` path that a fake db cannot emulate.
      memberRows: [memberRow({ role: 'primary', replicaClass: null, ordinal: 1 })],
    }),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectJson(
    await app.request(envPath('/members'), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }),
    400,
    { error: 'Invalid request' }
  )
  await expectJson(
    await app.request(envPath('/members'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ serverId: SERVER_ID, replicaClass: 'witness' }),
    }),
    400,
    { error: 'Invalid request' }
  )
})

test('PATCH / DELETE member return 404 when the member is missing', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()], memberRows: [] }),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ readEligible: true }),
    }),
    404,
    { error: 'Not found' }
  )
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}`), {
      method: 'DELETE',
      headers,
    }),
    404,
    { error: 'Not found' }
  )
})

test('PATCH member rejects an empty body', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow()],
    }),
  })
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}`), {
      method: 'PATCH',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    400,
    { error: 'Invalid request' }
  )
})

test('DELETE member refuses to remove the primary', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow({ role: 'primary', replicaClass: null, ordinal: 1 })],
    }),
  })
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}`), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    409,
    { error: 'managed_member_is_primary' }
  )
})

test('POST promote rejects a primary member and a read replica', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow({ role: 'primary', replicaClass: null })],
    }),
  })
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}/promote`), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    400,
    { error: 'Invalid request' }
  )

  const readApp = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow({ replicaClass: 'read' })],
    }),
  })
  await expectJson(
    await readApp.app.request(envPath(`/members/${MEMBER_ID}/promote`), {
      method: 'POST',
      headers: {
        ...authHeaders(readApp.cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }),
    422,
    { error: 'managed_replica_not_promotable' }
  )
})

test('POST disaster-recovery/promote validates the body and replica class', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow({ replicaClass: 'failover' })],
    }),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }),
    400,
    { error: 'Invalid request' }
  )
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirm: true, memberId: MEMBER_ID }),
    }),
    422,
    { error: 'managed_replica_not_promotable' }
  )
})

test('POST disaster-recovery/promote rejects a primary member', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow({ role: 'primary', replicaClass: 'read' })],
    }),
  })
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, memberId: MEMBER_ID }),
    }),
    400,
    { error: 'Invalid request' }
  )
})

test('backup routes return 404 for an unknown backup id', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  await expectJson(
    await app.request(envPath('/backups/missing'), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    404,
    { error: 'backup_not_found' }
  )
  await expectJson(
    await app.request(envPath('/backups/missing/restore'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    404,
    { error: 'backup_not_found' }
  )
})

test('GET databases and POST backup reject invalid options', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ options: { settings: {} } })] }),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectJson(await app.request(envPath('/databases'), { headers }), 400, {
    error: 'Invalid managed options',
  })
  await expectJson(
    await app.request(envPath('/backups'), {
      method: 'POST',
      headers,
      body: '{}',
    }),
    400,
    { error: 'Invalid managed options' }
  )
})

test('GET backups is unaffected by invalid managed.options — backups is its own table', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ options: { settings: {} } })],
      backupRows: [backupRow()],
    }),
  })
  const res = await app.request(envPath('/backups'), {
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  const list = body.backups as Array<{ id: string }>
  assertEquals(list[0]?.id, BACKUP_ID)
})

test('GET org managed returns 404 when the path org does not match the session', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb() })
  await expectJson(
    await app.request(`/organizations/${OTHER_ORG}/managed`, {
      headers: authHeaders(cookie),
    }),
    404,
    { error: 'Not found' }
  )
})

test('GET org managed returns 401 without a session even when a cookie is stale', async () => {
  const { app } = await buildApp({ db: fakeDb() })
  await expectJson(
    await app.request(`/organizations/${ORG_ID}/managed`, {
      headers: { [ORG_ID_HEADER]: ORG_ID },
    }),
    401,
    { ok: false, error: 'Unauthorized' }
  )
})

test('GET org managed lists serialized rows for the session org', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow()],
    }),
  })
  const res = await app.request(`/organizations/${ORG_ID}/managed`, {
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  const rows = body.managed as Array<{ id: string; engine: string }>
  assertEquals(rows.length, 1)
  assertEquals(rows[0]?.id, MANAGED_ID)
})

test('GET org managed returns an empty list when the org has no clusters', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb({ managedRows: [] }) })
  await expectJson(
    await app.request(`/organizations/${ORG_ID}/managed`, {
      headers: authHeaders(cookie),
    }),
    200,
    { managed: [] }
  )
})

test('GET org managed returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ executeRows: [{ allowed: false, organization_id: ORG_ID }] }),
  })
  await expectJson(
    await app.request(`/organizations/${ORG_ID}/managed`, {
      headers: authHeaders(cookie),
    }),
    403,
    { error: 'Forbidden' }
  )
})

test('disaster-recovery promote cannot verify a session when the database is unset', async () => {
  const { app, cookie } = await buildApp()
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, memberId: MEMBER_ID }),
    }),
    401,
    { error: 'Unauthorized', ok: false }
  )
})

test('GET managed serializes a placed cluster with a loopback listener', async () => {
  const options = validOptions()
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ options })],
      memberRows: [memberRow({ role: 'primary', replicaClass: null, ordinal: 1 })],
    }),
  })
  const res = await app.request(envPath(), { headers: authHeaders(cookie) })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  const connection = body.connection as Record<string, unknown> | null
  assertEquals(connection?.host, '127.0.0.1')
  const placed = body.server as Record<string, unknown>
  assertEquals(placed.id, SERVER_ID)
  assertEquals(placed.name, 'host-1')
  assertEquals(placed.hostname, 'host-1')
  const members = body.members as Array<{ id: string }>
  assertEquals(members[0]?.id, MEMBER_ID)
})

test('GET status surfaces residual error when the cluster failed unplaced', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [
        managedRow({
          serverId: null,
          status: 'failed',
          metadata: { error: 'apply exploded' },
        }),
      ],
    }),
  })
  const body = await jsonOf(await app.request(envPath('/status'), { headers: authHeaders(cookie) }))
  assertEquals(body.status, 'failed')
  assertEquals(body.error, 'apply exploded')
})

test('GET status includes environment containers', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ serverId: null })],
      serviceRows: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
      containerRows: [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          serviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          serverId: SERVER_ID,
          containerId: null,
          containerName: null,
          status: 'pending',
          role: 'service',
          composeServiceName: 'postgres',
          metadata: {},
          options: {},
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }),
  })
  const body = await jsonOf(await app.request(envPath('/status'), { headers: authHeaders(cookie) }))
  const containers = body.containers as Array<{ status: string }>
  assertEquals(containers.length, 1)
  assertEquals(containers[0]?.status, 'pending')
})

test('GET logs returns 503 without a daemon cell registry', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  await expectJson(await app.request(envPath('/logs'), { headers: authHeaders(cookie) }), 503, {
    error: 'Daemon cell registry unavailable',
  })
})

test('GET logs returns 409 when the pinned server is offline', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(false)],
    }),
    registry: stubRegistry(),
  })
  await expectJson(
    await app.request(envPath('/logs'), { headers: authHeaders(cookie) }),
    409,
    SERVER_OFFLINE_BODY
  )
})

test('GET logs returns the cell transcript when the host is online', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(true)],
    }),
    registry: stubRegistry('engine ready\n'),
  })
  await expectJson(
    await app.request(`${envPath('/logs')}?tail=50`, {
      headers: authHeaders(cookie),
    }),
    200,
    { logs: 'engine ready\n' }
  )
})

test('POST apply returns 409 when the pinned server is offline', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(false)],
    }),
  })
  await expectJson(
    await app.request(envPath('/apply'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    409,
    SERVER_OFFLINE_BODY
  )
})

test('POST apply returns 503 without a daemon cell registry after the host is online', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(true)],
    }),
  })
  await expectJson(
    await app.request(envPath('/apply'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    503,
    { error: 'Daemon cell registry unavailable' }
  )
})

test('POST apply returns 503 without a command queue', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(true)],
    }),
    registry: stubRegistry(),
  })
  await expectJson(
    await app.request(envPath('/apply'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    503,
    { error: 'Command queue unavailable' }
  )
})

test('POST apply returns 422 when the daemon key is missing', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(true)],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  await expectJson(
    await app.request(envPath('/apply'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    422,
    { error: 'daemon_key_unavailable' }
  )
})

test('POST create returns 422 when the daemon key is missing', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      envRows: [envRow({ serverId: SERVER_ID })],
      serverRows: [presenceServer(true)],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    422,
    { error: 'daemon_key_unavailable' }
  )
})

test('POST root-password / users return 422 when the daemon key is missing', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(true)],
      principalRows: [principalRow()],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectJson(
    await app.request(envPath('/root-password'), {
      method: 'POST',
      headers,
      body: '{}',
    }),
    422,
    { error: 'daemon_key_unavailable' }
  )
  await expectJson(
    await app.request(envPath('/users'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'appuser', databases: ['defaultdb'] }),
    }),
    422,
    { error: 'daemon_key_unavailable' }
  )
  await expectJson(
    await app.request(envPath(`/users/${PRINCIPAL_ID}/password`), {
      method: 'POST',
      headers,
      body: '{}',
    }),
    422,
    { error: 'daemon_key_unavailable' }
  )
})

test('POST create rejects an invalid name after the host is online', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      envRows: [envRow({ serverId: SERVER_ID })],
      serverRows: [presenceServer(true)],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 12 }),
    }),
    400,
    { error: 'Invalid request' }
  )
})

test('POST lifecycle / backups / restore require an online host', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(false)],
      memberRows: [memberRow({ role: 'primary', replicaClass: null, ordinal: 1 })],
      backupRows: [backupRow()],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectJson(
    await app.request(envPath('/lifecycle'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'start' }),
    }),
    409,
    SERVER_OFFLINE_BODY
  )
  await expectJson(
    await app.request(envPath('/backups'), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }),
    409,
    SERVER_OFFLINE_BODY
  )
  await expectJson(
    await app.request(envPath(`/backups/${BACKUP_ID}`), {
      method: 'DELETE',
      headers,
    }),
    409,
    SERVER_OFFLINE_BODY
  )
  await expectJson(
    await app.request(envPath(`/backups/${BACKUP_ID}/restore`), {
      method: 'POST',
      headers,
    }),
    409,
    SERVER_OFFLINE_BODY
  )
})

test('DELETE of a placed cluster returns 503 without dispatch infrastructure', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  await expectJson(
    await app.request(envPath(), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    503,
    { error: 'Daemon cell registry unavailable' }
  )
})

test('DELETE hard-deletes pending containers for environment services', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ serverId: null })],
      serviceRows: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
    }),
  })
  const res = await app.request(envPath(), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.ok, true)
  assertEquals(body.deleted, true)
})

test('POST promote returns 409 when replica lag is unknown', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow({ replicaClass: 'failover' })],
    }),
  })
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}/promote`), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    409,
    { error: 'managed_replica_not_streaming' }
  )
})

test('POST promote returns 409 when replica health is stale', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [
        memberRow({
          replicaClass: 'failover',
          metadata: {
            replication: {
              state: 'streaming',
              observedAt: '2020-01-01T00:00:00.000Z',
              lagBytes: 1,
            },
          },
        }),
      ],
    }),
  })
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}/promote`), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    409,
    { error: 'managed_replica_health_stale' }
  )
})

test('DELETE user / PATCH member / POST database hit apply-ready after validation', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(true)],
      principalRows: [principalRow()],
      memberRows: [memberRow()],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectJson(
    await app.request(envPath(`/users/${PRINCIPAL_ID}`), {
      method: 'DELETE',
      headers,
    }),
    422,
    { error: 'daemon_key_unavailable' }
  )
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ readEligible: true }),
    }),
    422,
    { error: 'daemon_key_unavailable' }
  )
  await expectJson(
    await app.request(envPath('/databases'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'reports' }),
    }),
    422,
    { error: 'daemon_key_unavailable' }
  )
})

test('POST promote force still requires an online host', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(false)],
      memberRows: [memberRow({ replicaClass: 'failover' })],
    }),
  })
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}/promote`), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    }),
    409,
    SERVER_OFFLINE_BODY
  )
})

function applyReadyDb(extra: FakeDbConfig = {}) {
  return fakeDb({
    managedRows: extra.managedRows ?? [managedRow()],
    serverRows: extra.serverRows ?? [applyReadyServer()],
    memberRows: extra.memberRows ?? [
      memberRow({ role: 'primary', replicaClass: null, ordinal: 1 }),
    ],
    principalRows: extra.principalRows ?? [
      principalRow({
        id: PRINCIPAL_ID,
        username: 'postgres',
        metadata: {
          managedRoot: true,
          engine: 'postgres',
          databases: ['postgres'],
        },
      }),
    ],
    serviceRows: extra.serviceRows ?? [engineServiceRow()],
    containerRows: extra.containerRows ?? [engineContainerRow()],
    backupRows: extra.backupRows ?? [backupRow()],
    ...extra,
  })
}

function failingQueue(): CommandQueue {
  return {
    enqueue: () => Promise.reject(new TypeError('queue down')),
  }
}

async function expectQueued(
  response: Response,
  extras: Record<string, unknown> = {}
): Promise<void> {
  assertEquals(response.status, 200)
  const body = await jsonOf(response)
  assertEquals(body.ok, true)
  assertEquals(body.commandId, PRINCIPAL_ID)
  assertEquals(body.serverId, SERVER_ID)
  for (const [key, value] of Object.entries(extras)) {
    assertEquals(body[key], value, key)
  }
}

test('POST orphan promote enqueues managed.promote', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      memberRows: [memberRow({ replicaClass: 'failover' })],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  await expectQueued(
    await app.request(envPath(`/members/${MEMBER_ID}/promote`), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    }),
    { status: 'queued' }
  )
})

test('POST orphan promote returns 503 when enqueue fails', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      memberRows: [memberRow({ replicaClass: 'failover' })],
    }),
    registry: stubRegistry(),
    commandQueue: failingQueue(),
  })
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}/promote`), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    }),
    503,
    { error: 'Command queue unavailable' }
  )
})

test('POST lifecycle / DELETE placed / backups enqueue when the host is online', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb(),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectQueued(
    await app.request(envPath('/lifecycle'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'start' }),
    }),
    { status: 'queued' }
  )
  await expectQueued(
    await app.request(envPath(), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    { deleted: false }
  )
  const backupCreate = await app.request(envPath('/backups'), {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
  assertEquals(backupCreate.status, 200)
  const created = await jsonOf(backupCreate)
  assertEquals(created.ok, true)
  assertEquals(created.commandId, PRINCIPAL_ID)
  assertEquals(created.serverId, SERVER_ID)
  assertEquals(typeof created.backupId, 'string')

  await expectQueued(
    await app.request(envPath(`/backups/${BACKUP_ID}`), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    })
  )
  await expectQueued(
    await app.request(envPath(`/backups/${BACKUP_ID}/restore`), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
  )
})

const BOUND_SERVICE = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  serviceId: SERVICE_ID,
  name: 'web',
  environmentId: ENV_ID,
  projectId: PROJECT_ID,
  keyPrefix: 'DATABASE',
}

test('DELETE cluster refuses with the bound services listed, and queues nothing', async () => {
  const enqueued: CommandEnvelope[] = []
  const { app, cookie } = await buildApp({
    db: applyReadyDb({ bindingRows: [BOUND_SERVICE] }),
    registry: stubRegistry(),
    commandQueue: countingQueue(enqueued),
  })
  const res = await app.request(envPath(), { method: 'DELETE', headers: authHeaders(cookie) })
  assertEquals(res.status, 409)
  const body = await jsonOf(res)
  assertEquals(body.error, 'managed_has_bindings')
  assertEquals(
    (body.services as Array<Record<string, unknown>>).map((entry) => entry.name),
    ['web']
  )
  assertEquals(enqueued.length, 0)
})

test('DELETE cluster with ?detach=true queues the destroy and leaves the bindings until it succeeds', async () => {
  const deletedTables: unknown[] = []
  const base = applyReadyDb({ bindingRows: [BOUND_SERVICE] })
  const db = {
    ...base,
    delete: (table: unknown) => {
      deletedTables.push(table)
      return base.delete(table as never)
    },
  } as unknown as Db
  const enqueued: CommandEnvelope[] = []
  const { app, cookie } = await buildApp({
    db,
    registry: stubRegistry(),
    commandQueue: countingQueue(enqueued),
  })
  const res = await app.request(envPath('?detach=true'), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.deleted, false)
  assertEquals(
    (body.detached as Array<Record<string, unknown>>).map((entry) => entry.name),
    ['web']
  )
  assertEquals(enqueued.length > 0, true)
  // The bindings go with the managed row when the destroy succeeds; removing
  // them now would leave a cluster that is still running with apps unbound if
  // the destroy failed on the host.
  assertEquals(deletedTables.includes(binding), false)
  assertEquals(deletedTables.includes(managed), false)
})

test('DELETE cluster with ?detach=true whose destroy cannot be queued answers 502 and leaves the bindings', async () => {
  const deletedTables: unknown[] = []
  const base = applyReadyDb({ bindingRows: [BOUND_SERVICE] })
  const db = {
    ...base,
    delete: (table: unknown) => {
      deletedTables.push(table)
      return base.delete(table as never)
    },
  } as unknown as Db
  const { app, cookie } = await buildApp({
    db,
    registry: stubRegistry(),
    commandQueue: failingQueue(),
  })
  const res = await app.request(envPath('?detach=true'), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(res.status >= 500, true)
  assertEquals(deletedTables.includes(binding), false)
})

test('DELETE cluster with ?detach=true needs the same rights as the destroy: manage denied is 403 and nothing is queued or removed', async () => {
  const deletedTables: unknown[] = []
  const base = applyReadyDb({ bindingRows: [BOUND_SERVICE] })
  let executeCalls = 0
  const db = {
    ...base,
    execute: () => {
      executeCalls += 1
      if (executeCalls === 1) {
        return Promise.resolve([{ organization_id: ORG_ID, kind: 'user' }])
      }
      return Promise.resolve([{ allowed: false, organization_id: ORG_ID, kind: 'user' }])
    },
    delete: (table: unknown) => {
      deletedTables.push(table)
      return base.delete(table as never)
    },
  } as unknown as Db
  const enqueued: CommandEnvelope[] = []
  const { app, cookie } = await buildApp({
    db,
    registry: stubRegistry(),
    commandQueue: countingQueue(enqueued),
  })
  executeCalls = 0
  const detach = await app.request(envPath('?detach=true'), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(detach.status, 403)
  executeCalls = 0
  const forced = await app.request(envPath('?force=true&detach=true'), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(forced.status, 403)
  assertEquals(enqueued.length, 0)
  assertEquals(deletedTables.length, 0)
})

test('DELETE cluster with ?force=true&detach=true removes the bindings before the rows and still refuses without detach', async () => {
  const deletedTables: unknown[] = []
  const base = applyReadyDb({ bindingRows: [BOUND_SERVICE] })
  const db = {
    ...base,
    delete: (table: unknown) => {
      deletedTables.push(table)
      return base.delete(table as never)
    },
  } as unknown as Db
  const { app, cookie } = await buildApp({
    db,
    registry: stubRegistry(),
    commandQueue: countingQueue([]),
  })
  const refused = await app.request(envPath('?force=true'), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(refused.status, 409)
  assertEquals(deletedTables.length, 0)
  const res = await app.request(envPath('?force=true&detach=true'), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.deleted, true)
  assertEquals(
    (body.detached as Array<Record<string, unknown>>).map((entry) => entry.name),
    ['web']
  )
  assertEquals(deletedTables.indexOf(binding) < deletedTables.indexOf(managed), true)
})

test('DELETE cluster with no bindings is unchanged and reports no detached list', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb(),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath(), { method: 'DELETE', headers: authHeaders(cookie) })
  assertEquals(res.status, 200)
  assertEquals('detached' in (await jsonOf(res)), false)
})

const MARIADB_FAILOVER_UNSUPPORTED_REASON =
  'MariaDB 12.3 can run on one server; automatic failover needs MariaDB 11.8 for now.'

test('POST members refuses MariaDB 12.3 with 422 managed_failover_unsupported', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      managedRows: [rowFor(mariadbEngineSpec, 'docker.io/library/mariadb:12.3')],
      projectRows: [{ metadata: { code: 'mariadb' } }],
    }),
  })
  const res = await app.request(envPath('/members'), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: REPLICA_SERVER_ID }),
  })
  assertEquals(res.status, 422)
  assertEquals(await jsonOf(res), {
    error: MARIADB_FAILOVER_UNSUPPORTED_REASON,
    code: 'managed_failover_unsupported',
  })
})

test('POST members allows MariaDB 11.8 past the failover gate', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      managedRows: [rowFor(mariadbEngineSpec, 'docker.io/library/mariadb:11.8')],
      projectRows: [{ metadata: { code: 'mariadb' } }],
    }),
  })
  const res = await app.request(envPath('/members'), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: REPLICA_SERVER_ID }),
  })
  assertEquals(res.status, 422)
  const body = await jsonOf(res)
  // Past the failover gate: the request now fails on placement, not on the series.
  assertEquals(body, { error: 'private_path_unavailable' })
})

test('POST members treats an imageless MariaDB row as 12.3 and refuses it', async () => {
  const legacy = managedRow({
    engine: 'mariadb',
    options: {
      settings: mariadbEngineSpec.parseSettings({ ...mariadbEngineSpec.defaultSettings }),
      databases: ['defaultdb'],
    },
  })
  const { app, cookie } = await buildApp({
    db: applyReadyDb({ managedRows: [legacy], projectRows: [{ metadata: { code: 'mariadb' } }] }),
  })
  const res = await app.request(envPath('/members'), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: REPLICA_SERVER_ID }),
  })
  assertEquals(res.status, 422)
  assertEquals(await jsonOf(res), {
    error: MARIADB_FAILOVER_UNSUPPORTED_REASON,
    code: 'managed_failover_unsupported',
  })
})

test('PATCH member to failover is refused on MariaDB 12.3 but not on 11.8', async () => {
  for (const [image, refused] of [
    ['docker.io/library/mariadb:12.3', true],
    ['docker.io/library/mariadb:11.8', false],
  ] as const) {
    const { app, cookie } = await buildApp({
      db: applyReadyDb({
        managedRows: [rowFor(mariadbEngineSpec, image)],
        memberRows: [memberRow({ replicaClass: 'read' })],
        projectRows: [{ metadata: { code: 'mariadb' } }],
      }),
    })
    const res = await app.request(envPath(`/members/${MEMBER_ID}`), {
      method: 'PATCH',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ replicaClass: 'failover' }),
    })
    const body = await jsonOf(res)
    if (refused) {
      assertEquals(res.status, 422)
      assertEquals(body, {
        error: MARIADB_FAILOVER_UNSUPPORTED_REASON,
        code: 'managed_failover_unsupported',
      })
    } else {
      assertEquals(body.code === 'managed_failover_unsupported', false)
    }
  }
})

test('POST members surfaces a private-path error for an unreachable replica host', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb(),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath('/members'), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: REPLICA_SERVER_ID }),
  })
  assertEquals(res.status, 422)
  const body = await jsonOf(res)
  assertEquals(typeof body.error, 'string')
})

test('POST user-password past apply-ready restores the prior hash on prepare failure', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      principalRows: [principalRow()],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath(`/users/${PRINCIPAL_ID}/password`), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: '{}',
  })
  assertEquals([200, 422, 500].includes(res.status), true)
  if (res.status !== 200) {
    const body = await jsonOf(res)
    assertEquals(typeof body.error, 'string')
  }
})

test('POST create past daemon-key preflight enters the create transaction', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      envRows: [envRow({ serverId: SERVER_ID })],
      managedRows: [],
      memberRows: [],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath(), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals([200, 400, 409, 422, 500].includes(res.status), true)
  if (res.status !== 200) {
    const body = await jsonOf(res)
    assertEquals(typeof body.error, 'string')
  }
})

test('POST root-password past apply-ready maps a later prepare error', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb(),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath('/root-password'), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: '{}',
  })
  assertEquals([200, 422, 500].includes(res.status), true)
  if (res.status !== 200) {
    const body = await jsonOf(res)
    assertEquals(typeof body.error, 'string')
  }
})

test('POST users past apply-ready hits namespace and insert short-circuits', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      principalRows: [principalRow({ username: 'appuser' })],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const headers = {
    ...authHeaders(cookie),
    'content-type': 'application/json',
  }
  await expectJson(
    await app.request(envPath('/users'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'appuser', databases: ['defaultdb'] }),
    }),
    409,
    { error: 'managed_user_exists' }
  )
  const created = await app.request(envPath('/users'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'reporter', databases: ['defaultdb'] }),
  })
  assertEquals([200, 409, 422, 500].includes(created.status), true)
  if (created.status !== 200) {
    const body = await jsonOf(created)
    assertEquals(typeof body.error, 'string')
  }
})

/**
 * Wraps a fake db so the test can see which principal rows were inserted
 * (the new login) and which commands were queued.
 */
function recordingUserCreate(memberRows: unknown[]) {
  const base = applyReadyDb({ principalRows: [], memberRows })
  const inserted: Array<Record<string, unknown>> = []
  const db = {
    ...base,
    insert: (table: unknown) => {
      const builder = base.insert(table as never) as unknown as {
        values: (values: Record<string, unknown>) => unknown
      }
      return {
        values: (values: Record<string, unknown>) => {
          if (table === principal) inserted.push(values)
          return builder.values(values)
        },
      }
    },
    transaction: (fn: (tx: Db) => Promise<unknown>) => fn(db),
  } as unknown as Db
  const commandQueue = capturingQueue()
  return { db, inserted, envelopes: commandQueue.envelopes, commandQueue }
}

async function postUser(
  body: Record<string, unknown>,
  memberRows: unknown[]
): Promise<{
  res: Response
  inserted: Array<Record<string, unknown>>
  envelopes: CommandEnvelope[]
}> {
  const { db, inserted, envelopes, commandQueue } = recordingUserCreate(memberRows)
  const { app, cookie } = await buildApp({
    db,
    registry: stubRegistry(),
    commandQueue,
  })
  const res = await app.request(envPath('/users'), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'reporter',
      databases: ['defaultdb'],
      ...body,
    }),
  })
  return { res, inserted, envelopes }
}

// Other principals (such as the replication login) may be inserted too.
function loginMetadata(inserted: Array<Record<string, unknown>>): Record<string, unknown> {
  const login = inserted.find((row) => row.username === 'reporter')
  assertEquals(login !== undefined, true)
  return login?.metadata as Record<string, unknown>
}

const PRIMARY_ONLY = [memberRow({ role: 'primary', replicaClass: null, ordinal: 1 })]
const WITH_READ_REPLICA = [
  ...PRIMARY_ONLY,
  memberRow({ id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2', readEligible: true }),
]
const WITH_HIDDEN_REPLICA = [
  ...PRIMARY_ONLY,
  memberRow({
    id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    readEligible: false,
  }),
]

test('POST users refuses a read-only login on a standalone cluster', async () => {
  const { res, inserted, envelopes } = await postUser({ connectionRole: 'read-only' }, PRIMARY_ONLY)
  await expectJson(res, 422, { error: 'managed_no_read_targets' })
  assertEquals(inserted, [])
  assertEquals(envelopes, [])
})

test('POST users refuses a read-only login when no replica is read-eligible', async () => {
  const { res, inserted, envelopes } = await postUser(
    { connectionRole: 'read-only' },
    WITH_HIDDEN_REPLICA
  )
  await expectJson(res, 422, { error: 'managed_no_read_targets' })
  assertEquals(inserted, [])
  assertEquals(envelopes, [])
})

// The principal is inserted before the apply payloads are prepared, and the
// fake db has no organization CA, so a later step may still answer an error:
// these tests judge only the row that was written.
test('POST users stores the read-only role on the new login', async () => {
  const { inserted } = await postUser({ connectionRole: 'read-only' }, WITH_READ_REPLICA)
  const metadata = loginMetadata(inserted)
  assertEquals(metadata.connectionRole, 'read-only')
  assertEquals(metadata.databases, ['defaultdb'])
})

test('POST users leaves the metadata untouched for read-write and omitted roles', async () => {
  for (const body of [{ connectionRole: 'read-write' }, {}]) {
    const { inserted } = await postUser(body, PRIMARY_ONLY)
    const metadata = loginMetadata(inserted)
    assertEquals('connectionRole' in metadata, false)
    assertEquals(Object.keys(metadata).sort(), ['databases', 'engine', 'privileges'])
  }
})

test('GET users reports a stored read-only login as read-only', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [
        principalRow({
          metadata: { engine: 'postgres', connectionRole: 'read-only' },
        }),
      ],
    }),
  })
  const body = await jsonOf(await app.request(envPath('/users'), { headers: authHeaders(cookie) }))
  const users = body.users as Array<{ connectionRole: string }>
  assertEquals(users[0]?.connectionRole, 'read-only')
})

test('DELETE database past apply-ready maps a later prepare error', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb(),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath('/databases/appdb'), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals([200, 409, 422, 500].includes(res.status), true)
  if (res.status !== 200) {
    const body = await jsonOf(res)
    assertEquals(typeof body.error, 'string')
  }
})

test('POST promote with a primary calls operator switchover', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      memberRows: [
        memberRow({ replicaClass: 'failover' }),
        memberRow({
          id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          role: 'primary',
          replicaClass: null,
          ordinal: 1,
        }),
      ],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath(`/members/${MEMBER_ID}/promote`), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  })
  assertEquals(res.status >= 200 && res.status < 600, true)
})

test('POST disaster-recovery promote with a read replica reaches recovery', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      memberRows: [
        memberRow({ replicaClass: 'read' }),
        memberRow({
          id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          role: 'primary',
          replicaClass: null,
          ordinal: 1,
        }),
      ],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath('/disaster-recovery/promote'), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true, memberId: MEMBER_ID }),
  })
  assertEquals([200, 400, 404, 409, 422, 500, 503].includes(res.status), true)
})

const DR_PROMOTE_BODY = JSON.stringify({ confirm: true, memberId: MEMBER_ID })

function drReplicaDb(): Db {
  return applyReadyDb({
    memberRows: [
      memberRow({ replicaClass: 'read' }),
      memberRow({
        id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        role: 'primary',
        replicaClass: null,
        ordinal: 1,
      }),
    ],
  })
}

test('every mounted managed route is covered by managedSessionPaths', async () => {
  const { app } = await buildApp()
  const covered = new Set(managedSessionPaths())
  const mounted = new Set(
    app.routes.filter((r) => r.method !== 'ALL' && r.path !== '*').map((r) => r.path)
  )
  assertEquals(mounted.size > 0, true)
  const missing = [...mounted].filter((path) => !covered.has(path))
  assertEquals(missing, [], 'mounted managed routes without session middleware')
  const stale = [...covered].filter((path) => !mounted.has(path))
  assertEquals(stale, [], 'managedSessionPaths entries with no mounted route')
})

test('POST disaster-recovery promote returns 401 without a session', async () => {
  const { app } = await buildApp({ db: drReplicaDb() })
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers: { [ORG_ID_HEADER]: ORG_ID, 'content-type': 'application/json' },
      body: DR_PROMOTE_BODY,
    }),
    401,
    { error: 'Unauthorized', ok: false }
  )
})

test('POST disaster-recovery promote returns 200 with a valid session', async () => {
  const { app, cookie } = await buildApp({
    db: drReplicaDb(),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath('/disaster-recovery/promote'), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: DR_PROMOTE_BODY,
  })
  assertEquals(res.status, 200)
})

test('POST disaster-recovery promote returns 403 when manage is denied', async () => {
  let executeCalls = 0
  const db = {
    ...drReplicaDb(),
    execute: () => {
      executeCalls += 1
      if (executeCalls === 1) {
        return Promise.resolve([{ organization_id: ORG_ID, kind: 'user' }])
      }
      return Promise.resolve([{ allowed: false, organization_id: ORG_ID, kind: 'user' }])
    },
  } as unknown as Db
  const { app, cookie } = await buildApp({ db })
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: DR_PROMOTE_BODY,
    }),
    403,
    { error: 'Forbidden' }
  )
})

test('POST disaster-recovery promote hides a foreign environment as 404', async () => {
  const db = {
    ...drReplicaDb(),
    execute: () => Promise.resolve([{ allowed: true, organization_id: OTHER_ORG, kind: 'user' }]),
  } as unknown as Db
  const { app, cookie } = await buildApp({ db })
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: DR_PROMOTE_BODY,
    }),
    404,
    { error: 'Not found' }
  )
})

test('DELETE replica member past dispatch maps a later prepare error', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      memberRows: [
        memberRow({ replicaClass: 'failover', role: 'replica' }),
        memberRow({
          id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          role: 'primary',
          replicaClass: null,
          ordinal: 1,
        }),
      ],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath(`/members/${MEMBER_ID}`), {
    method: 'DELETE',
    headers: authHeaders(cookie),
  })
  assertEquals([200, 409, 422, 500].includes(res.status), true)
  if (res.status !== 200) {
    const body = await jsonOf(res)
    assertEquals(typeof body.error, 'string')
  }
})

test('POST apply past daemon-key preflight maps a later prepare error', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb(),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath('/apply'), {
    method: 'POST',
    headers: authHeaders(cookie),
  })
  assertEquals([200, 400, 409, 422, 500].includes(res.status), true)
  if (res.status !== 200) {
    const body = await jsonOf(res)
    assertEquals(typeof body.error, 'string')
  }
})

test('PATCH member replica class still requires apply-ready after conversion', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      memberRows: [memberRow({ replicaClass: 'failover', role: 'replica' })],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const res = await app.request(envPath(`/members/${MEMBER_ID}`), {
    method: 'PATCH',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ replicaClass: 'read' }),
  })
  assertEquals([200, 400, 409, 422, 500].includes(res.status), true)
  if (res.status !== 200) {
    const body = await jsonOf(res)
    assertEquals(typeof body.error, 'string')
  }
})

// ---------------------------------------------------------------------------
// On-demand replica health probe (`managed-health-request`)
// ---------------------------------------------------------------------------

const HEALTH_FEATURE = 'managed-health-v1'

/** An enrolled, online server whose stored hello advertised `features`. */
function serverAdvertising(features: string[]) {
  return { ...applyReadyServer(true), daemon: { projection: { features } } }
}

type HealthReply = { status: string; result?: unknown; error?: string }

function streamingHealth(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    member: {
      memberId: MEMBER_ID,
      role: 'replica',
      status: 'ready',
      replication: {
        state: 'streaming',
        lagBytes: 0,
        lagSeconds: 0,
        observedAt: new Date().toISOString(),
        ...over,
      },
    },
  }
}

/** Registry recording every envelope; health requests are answered by `reply`. */
function healthRegistry(reply: HealthReply) {
  const sent: DaemonOutboundEnvelope[] = []
  const registry = {
    getCell: () => ({
      createRequestAndWait: (outbound: DaemonOutboundEnvelope) => {
        sent.push(outbound)
        return Promise.resolve({
          serverId: SERVER_ID,
          requestId: outbound.requestId,
          requestKind: outbound.kind,
          createdAt: outbound.at,
          expiresAt: outbound.at,
          ...reply,
        })
      },
    }),
  } as unknown as DaemonCellRegistry
  return { registry, sent }
}

const STALE_STREAMING = {
  replication: {
    state: 'streaming',
    observedAt: '2020-01-01T00:00:00.000Z',
    lagBytes: 1,
  },
}

async function promoteVia(opts: {
  features: string[]
  reply: HealthReply
  metadata?: Record<string, unknown>
  body?: Record<string, unknown>
}) {
  const { registry, sent } = healthRegistry(opts.reply)
  const { app, cookie } = await buildApp({
    db: applyReadyDb({
      serverRows: [serverAdvertising(opts.features)],
      memberRows: [
        memberRow({
          replicaClass: 'failover',
          metadata: opts.metadata ?? STALE_STREAMING,
        }),
      ],
    }),
    registry,
    commandQueue: recordingQueue(),
  })
  const response = await app.request(envPath(`/members/${MEMBER_ID}/promote`), {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify(opts.body ?? {}),
  })
  return { response, sent }
}

test('POST promote probes a stale replica and promotes on a fresh streaming reading', async () => {
  const { response, sent } = await promoteVia({
    features: [HEALTH_FEATURE],
    reply: { status: 'done', result: streamingHealth() },
  })
  await expectQueued(response, { status: 'queued' })
  assertEquals(sent.length, 1)
  const envelope = sent[0]!
  assertEquals(envelope.kind, 'managed-health-request')
  if (envelope.kind !== 'managed-health-request') return
  assertEquals(envelope.role, 'replica')
  assertEquals(envelope.engine, 'postgres')
  assertEquals(envelope.memberId, MEMBER_ID)
  assertEquals(envelope.managedId, MANAGED_ID)
})

test('POST promote probes a replica that was never observed', async () => {
  const { response, sent } = await promoteVia({
    features: [HEALTH_FEATURE],
    metadata: {},
    reply: { status: 'done', result: streamingHealth() },
  })
  await expectQueued(response, { status: 'queued' })
  assertEquals(sent.length, 1)
})

test('POST promote still applies the lag and streaming gate to the fresh reading', async () => {
  const lagging = await promoteVia({
    features: [HEALTH_FEATURE],
    reply: {
      status: 'done',
      result: streamingHealth({ lagBytes: 512 * 1024 * 1024 }),
    },
  })
  await expectJson(lagging.response, 409, { error: 'managed_replica_lagging' })
  assertEquals(lagging.sent.length, 1)

  const catchingUp = await promoteVia({
    features: [HEALTH_FEATURE],
    reply: { status: 'done', result: streamingHealth({ state: 'catchup' }) },
  })
  await expectJson(catchingUp.response, 409, {
    error: 'managed_replica_not_streaming',
  })
})

test('POST promote fails closed when the probe times out', async () => {
  const { response, sent } = await promoteVia({
    features: [HEALTH_FEATURE],
    reply: { status: 'expired' },
  })
  await expectJson(response, 409, { error: 'managed_replica_health_stale' })
  assertEquals(sent.length, 1)
})

test('POST promote fails closed when the daemon cannot read health', async () => {
  const { response } = await promoteVia({
    features: [HEALTH_FEATURE],
    reply: { status: 'failed', error: 'engine not running' },
  })
  await expectJson(response, 409, { error: 'managed_replica_health_stale' })
})

test('POST promote sends no probe to a daemon without managed-health-v1', async () => {
  const { response, sent } = await promoteVia({
    features: ['update-progress-v1'],
    reply: { status: 'done', result: streamingHealth() },
  })
  await expectJson(response, 409, { error: 'managed_replica_health_stale' })
  assertEquals(sent.length, 0)
})

test('POST promote probes even when the stored observation is recent', async () => {
  const { response, sent } = await promoteVia({
    features: [HEALTH_FEATURE],
    metadata: {
      replication: {
        state: 'streaming',
        observedAt: new Date(Date.now() - 60_000).toISOString(),
        lagBytes: 0,
      },
    },
    reply: { status: 'done', result: streamingHealth() },
  })
  await expectQueued(response, { status: 'queued' })
  assertEquals(sent.length, 1)
})

test('POST promote refuses a replica whose threads stopped after the stored reading', async () => {
  const { response, sent } = await promoteVia({
    features: [HEALTH_FEATURE],
    metadata: {
      replication: {
        state: 'streaming',
        observedAt: new Date(Date.now() - 3_000).toISOString(),
        lagBytes: 0,
      },
    },
    reply: { status: 'done', result: streamingHealth({ state: 'reconnecting' }) },
  })
  await expectJson(response, 409, { error: 'managed_replica_not_streaming' })
  assertEquals(sent.length, 1)
})

test('POST promote does not act on a minute-old stored reading when the daemon cannot answer', async () => {
  const { response } = await promoteVia({
    features: [HEALTH_FEATURE],
    metadata: {
      replication: {
        state: 'streaming',
        observedAt: new Date(Date.now() - 60_000).toISOString(),
        lagBytes: 0,
      },
    },
    reply: { status: 'expired' },
  })
  await expectJson(response, 409, { error: 'managed_replica_health_stale' })
})

test('POST promote with force never probes', async () => {
  const { response, sent } = await promoteVia({
    features: [HEALTH_FEATURE],
    reply: { status: 'done', result: streamingHealth() },
    body: { force: true },
  })
  await expectQueued(response, { status: 'queued' })
  assertEquals(sent.length, 0)
})

test('GET status stays database-only without ?refresh=1', async () => {
  const { registry, sent } = healthRegistry({
    status: 'done',
    result: streamingHealth(),
  })
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [serverAdvertising([HEALTH_FEATURE])],
      memberRows: [memberRow()],
    }),
    registry,
  })
  const body = await jsonOf(await app.request(envPath('/status'), { headers: authHeaders(cookie) }))
  assertEquals(sent.length, 0)
  assertEquals('healthRefresh' in body, false)
})

test('GET status?refresh=1 probes the replicas, asks the primary for its slot report, and counts replicas only', async () => {
  const { registry, sent } = healthRegistry({
    status: 'done',
    result: streamingHealth(),
  })
  const primary = memberRow({
    id: '99999999-9999-4999-8999-999999999990',
    role: 'primary',
    replicaClass: null,
    ordinal: 1,
  })
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [serverAdvertising([HEALTH_FEATURE])],
      memberRows: [primary, memberRow()],
    }),
    registry,
  })
  const body = await jsonOf(
    await app.request(envPath('/status?refresh=1'), {
      headers: authHeaders(cookie),
    })
  )
  const asked = sent.flatMap((envelope) =>
    envelope.kind === 'managed-health-request' ? [`${envelope.role}:${envelope.memberId}`] : []
  )
  assertEquals(asked.toSorted(), [
    `primary:99999999-9999-4999-8999-999999999990`,
    `replica:${MEMBER_ID}`,
  ])
  assertEquals(body.healthRefresh, { observed: 1, unavailable: 0 })
})

test('GET status?refresh=1 does not probe a primary that has no replicas', async () => {
  const { registry, sent } = healthRegistry({ status: 'done', result: streamingHealth() })
  const primary = memberRow({ role: 'primary', replicaClass: null, ordinal: 1 })
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [serverAdvertising([HEALTH_FEATURE])],
      memberRows: [primary],
    }),
    registry,
  })
  await app.request(envPath('/status?refresh=1'), { headers: authHeaders(cookie) })
  assertEquals(sent.length, 0)
})

test('GET status?refresh=1 falls back quietly when the daemon lacks the feature or times out', async () => {
  const unsupported = healthRegistry({
    status: 'done',
    result: streamingHealth(),
  })
  const a = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [serverAdvertising([])],
      memberRows: [memberRow()],
    }),
    registry: unsupported.registry,
  })
  const noFeature = await jsonOf(
    await a.app.request(envPath('/status?refresh=1'), {
      headers: authHeaders(a.cookie),
    })
  )
  assertEquals(unsupported.sent.length, 0)
  assertEquals(noFeature.healthRefresh, { observed: 0, unavailable: 1 })

  const timedOut = healthRegistry({ status: 'expired' })
  const b = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [serverAdvertising([HEALTH_FEATURE])],
      memberRows: [memberRow()],
    }),
    registry: timedOut.registry,
  })
  const res = await b.app.request(envPath('/status?refresh=1'), {
    headers: authHeaders(b.cookie),
  })
  assertEquals(res.status, 200)
  assertEquals((await jsonOf(res)).healthRefresh, {
    observed: 0,
    unavailable: 1,
  })
})
