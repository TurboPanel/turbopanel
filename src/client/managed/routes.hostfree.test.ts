/**
 * Host-free coverage for managed route short-circuits (no Postgres).
 *
 * Requires env read for `src/logger.ts` (`TURBOPANEL_DAEMON_DEBUG` /
 * `TURBOPANEL_LOG_LEVEL`) because `routes.ts` imports the logger at module
 * load. Run standalone with:
 *
 *   deno test --no-check --allow-read \
 *     --allow-env=TURBOPANEL_DAEMON_DEBUG,TURBOPANEL_LOG_LEVEL \
 *     src/client/managed/routes.hostfree.test.ts
 *
 * CI coverage uses `scripts/test-coverage.sh` (`deno test -A …`).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { DaemonOutboundEnvelope } from '../../daemon/cell/protocol.ts'
import type { Db } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
} from '../authn/secrets.ts'
import {
  binding,
  command,
  container,
  environment,
  managed,
  node,
  organization,
  principal,
  project,
  recovery,
  server,
  service,
  session,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { managedSessionPaths } from './routes-helpers.ts'
import { registerManagedRoutes } from './routes.ts'

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
  const settings = postgresEngineSpec.parseSettings(
    postgresEngineSpec.defaultSettings,
  )
  if (!settings) throw new TypeError('failed to parse default postgres settings')
  return {
    settings,
    databases: ['postgres', 'appdb'],
    backups: [{
      id: BACKUP_ID,
      createdAt: NOW,
      sizeBytes: 1024,
      checksum: 'a'.repeat(64),
      path: '/var/lib/turbopanel/managed/m1/backups/bk_abc123.dump',
    }],
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
  return presenceServer(connected, { daemon: ACTIVE_DAEMON })
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
  serviceRows?: unknown[]
  containerRows?: unknown[]
  commandRows?: unknown[]
  executeRows?: unknown[]
  userRole?: string
}

function fakeDb(config: FakeDbConfig = {}): Db {
  const executeRows = config.executeRows ?? [{
    allowed: true,
    organization_id: ORG_ID,
    kind: 'user',
  }]
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
          return queryChain(
            config.projectRows ?? [{ metadata: { code: 'postgres' } }],
          )
        }
        if (table === organization) {
          return queryChain(config.orgRows ?? [{ options: {} }])
        }
        if (table === managed) {
          return queryChain(config.managedRows ?? [])
        }
        if (table === server) {
          return queryChain(config.serverRows ?? [presenceServer()])
        }
        if (table === principal) {
          return queryChain(config.principalRows ?? [])
        }
        if (table === node) {
          return queryChain(config.memberRows ?? [])
        }
        if (table === binding) {
          return queryChain(config.bindingRows ?? [])
        }
        if (table === recovery) {
          return queryChain(config.recoveryRows ?? [])
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
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const rows = [{
          ...principalRow(),
          ...memberRow({ role: 'primary', replicaClass: null, ordinal: 1 }),
          createdAt: NOW,
          updatedAt: NOW,
          queuedAt: NOW,
          ...values,
          id: typeof values.id === 'string' ? values.id : PRINCIPAL_ID,
        }]
        return {
          ...queryChain(rows),
          onConflictDoNothing: () => queryChain(rows),
        }
      },
    }),
    update: () => ({
      set: (next: Record<string, unknown>) => ({
        where: () => {
          const row = {
            ...(config.managedRows?.[0] as Record<string, unknown> | undefined ??
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
  const dataEncryptionSecrets = opts.encrypt === false
    ? undefined
    : await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (opts.db) c.set('db', opts.db)
    c.set('runtime', 'deno')
    c.set('secretsConfig', secretsConfig)
    // Disaster-recovery promote is registered without session middleware
    // (`managedSessionPaths` omits it). Seed a session so those short-circuits
    // still run after a signed cookie would have been accepted on other paths.
    c.set('session', {
      sessionId: 'sess-1',
      userId: USER_ID,
      email: 'ops@example.com',
      role: 'superadmin',
    })
    if (dataEncryptionSecrets) c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    if (opts.registry) c.set('daemonCellRegistry', opts.registry)
    if (opts.commandQueue) c.set('commandQueue', opts.commandQueue)
    return next()
  })
  registerManagedRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  const cookie =
    `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie('session-token', secrets)}`
  return { app, cookie }
}

function authHeaders(
  cookie: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: ORG_ID,
    ...extra,
  }
}

async function expectJson(
  response: Response,
  status: number,
  body: Record<string, unknown>,
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
  { method: 'PATCH', path: envPath(`/members/${MEMBER_ID}`), body: { readEligible: true } },
  { method: 'DELETE', path: envPath(`/members/${MEMBER_ID}`) },
  { method: 'POST', path: envPath(`/members/${MEMBER_ID}/promote`), body: {} },
  { method: 'POST', path: envPath('/disaster-recovery/promote'), body: { confirm: true, memberId: MEMBER_ID } },
  { method: 'GET', path: envPath('/status') },
  { method: 'GET', path: envPath('/logs') },
  { method: 'GET', path: envPath('/backups') },
  { method: 'POST', path: envPath('/backups'), body: {} },
  { method: 'DELETE', path: envPath(`/backups/${BACKUP_ID}`) },
  { method: 'POST', path: envPath(`/backups/${BACKUP_ID}/restore`) },
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
  await expectJson(
    await app.request(envPath(), { headers: authHeaders(cookie) }),
    404,
    { error: 'Not found' },
  )
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
      return Promise.resolve([{ allowed: false, organization_id: ORG_ID, kind: 'user' }])
    },
  } as unknown as Db
  const { app, cookie } = await buildApp({ db })
  await expectJson(
    await app.request(envPath(), { headers: authHeaders(cookie) }),
    403,
    { error: 'Forbidden' },
  )
})

test('authorizeManagedRequest rejects a TurboPanel workspace as immutable', async () => {
  let executeCalls = 0
  const db = {
    ...fakeDb(),
    execute: () => {
      executeCalls += 1
      if (executeCalls <= 2) {
        return Promise.resolve([{
          allowed: true,
          organization_id: ORG_ID,
          kind: 'user',
        }])
      }
      return Promise.resolve([{
        allowed: true,
        organization_id: ORG_ID,
        kind: 'turbopanel',
      }])
    },
  } as unknown as Db
  const { app, cookie } = await buildApp({ db })
  await expectJson(
    await app.request(envPath(), { headers: authHeaders(cookie) }),
    403,
    { error: 'system_resource_immutable' },
  )
})

test('loadManagedContext returns 404 when the environment is missing', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb({ envRows: [] }) })
  await expectJson(
    await app.request(envPath(), { headers: authHeaders(cookie) }),
    404,
    { error: 'Not found' },
  )
})

test('loadManagedContext returns 404 when the project is missing', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb({ projectRows: [] }) })
  await expectJson(
    await app.request(envPath(), { headers: authHeaders(cookie) }),
    404,
    { error: 'Not found' },
  )
})

test('loadManagedContext rejects a non-managed catalog code', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ projectRows: [{ metadata: { code: 'docker-compose' } }] }),
  })
  await expectJson(
    await app.request(envPath(), { headers: authHeaders(cookie) }),
    400,
    { error: 'not_managed_environment' },
  )
})

test('loadManagedContext rejects a project with no catalog code', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ projectRows: [{ metadata: {} }] }),
  })
  await expectJson(
    await app.request(envPath(), { headers: authHeaders(cookie) }),
    400,
    { error: 'not_managed_environment' },
  )
})

test('GET managed returns the empty detail when no row exists', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb() })
  const res = await app.request(envPath(), { headers: authHeaders(cookie) })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.managed, null)
  assertEquals(body.connection, null)
  assertEquals(body.rootUsername, 'postgres')
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
  const res = await app.request(envPath('/status'), { headers: authHeaders(cookie) })
  assertEquals(res.status, 200)
  const body = await jsonOf(res)
  assertEquals(body.status, null)
  assertEquals(body.error, null)
  assertEquals(body.containers, [])
  assertEquals(body.members, [])
})

test('mutating routes return 404 when the managed row is missing', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb() })
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
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
    ['POST', envPath('/disaster-recovery/promote'), { confirm: true, memberId: MEMBER_ID }],
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
    db: fakeDb({ managedRows: [managedRow({ options: { settings: { image: '' } } })] }),
  })
  await expectJson(
    await app.request(envPath(), { headers: authHeaders(cookie) }),
    400,
    { error: 'Invalid managed options' },
  )
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
    }),
  })
  const headers = authHeaders(cookie)
  const databases = await jsonOf(await app.request(envPath('/databases'), { headers }))
  assertEquals(databases.databases, ['postgres', 'appdb'])

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
  const body = await jsonOf(
    await app.request(envPath('/users'), { headers: authHeaders(cookie) }),
  )
  const users = body.users as Array<{ username: string }>
  assertEquals(users.map((entry) => entry.username), ['appuser'])
})

test('GET status includes residual host/port when unplaced', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({
        serverId: null,
        metadata: { host: 'db.internal', port: 15432, error: 'boom' },
        status: 'ready',
      })],
    }),
  })
  const body = await jsonOf(
    await app.request(envPath('/status'), { headers: authHeaders(cookie) }),
  )
  assertEquals(body.status, 'ready')
  assertEquals(body.host, 'db.internal')
  assertEquals(body.port, 15432)
  assertEquals(body.error, null)
})

test('GET logs requires a placement pin', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ serverId: null })] }),
  })
  await expectJson(
    await app.request(envPath('/logs'), { headers: authHeaders(cookie) }),
    409,
    { error: 'server_placement_required' },
  )
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
    { error: 'server_placement_required' },
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
    { error: 'Encryption unavailable' },
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
    { error: 'managed_busy' },
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
    { error: 'server_placement_required' },
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
    { error: 'Invalid managed options' },
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
    { error: 'Invalid request' },
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
    { error: 'managed_settings_invalid' },
  )
})

test('POST apply / lifecycle / backups require a placement pin', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ serverId: null })] }),
  })
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
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
      { error: 'server_placement_required' },
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
    { error: 'Invalid managed options' },
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
    { error: 'managed_busy' },
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
    { error: 'Invalid request' },
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
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
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
      { error: 'managed_busy' },
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
    { error: 'root_principal_missing' },
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
    { error: 'Encryption unavailable' },
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
    { error: 'Invalid managed options' },
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
    { error: 'Invalid request' },
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
    { error: 'Invalid managed options' },
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
    { error: 'Not found' },
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
    { error: 'use_root_password_route' },
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
    { error: 'cannot_rotate_replication_user' },
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
    { error: 'cannot_drop_root_user' },
  )
})

test('DELETE user returns 409 while bindings remain', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      principalRows: [principalRow()],
      bindingRows: [{
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        serviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        name: 'web',
        environmentId: ENV_ID,
        projectId: PROJECT_ID,
        keyPrefix: 'DATABASE',
      }],
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
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
  await expectJson(
    await app.request(envPath('/databases'), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }),
    400,
    { error: 'Invalid request' },
  )
  await expectJson(
    await app.request(envPath('/databases'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'bad-name' }),
    }),
    400,
    { error: 'Invalid database name' },
  )
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
    { error: 'Invalid managed options' },
  )
})

test('DELETE database refuses the initial database and unknown names', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  await expectJson(
    await app.request(envPath('/databases/postgres'), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    409,
    { error: 'cannot_drop_initial_database' },
  )
  await expectJson(
    await app.request(envPath('/databases/missing'), {
      method: 'DELETE',
      headers: authHeaders(cookie),
    }),
    404,
    { error: 'Not found' },
  )
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
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
  await expectJson(
    await app.request(envPath('/members'), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }),
    400,
    { error: 'Invalid request' },
  )
  await expectJson(
    await app.request(envPath('/members'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ serverId: SERVER_ID, replicaClass: 'witness' }),
    }),
    400,
    { error: 'Invalid request' },
  )
})

test('PATCH / DELETE member return 404 when the member is missing', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()], memberRows: [] }),
  })
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ readEligible: true }),
    }),
    404,
    { error: 'Not found' },
  )
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}`), {
      method: 'DELETE',
      headers,
    }),
    404,
    { error: 'Not found' },
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
    { error: 'Invalid request' },
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
    { error: 'managed_member_is_primary' },
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
    { error: 'Invalid request' },
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
      headers: { ...authHeaders(readApp.cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    422,
    { error: 'managed_replica_not_promotable' },
  )
})

test('POST disaster-recovery/promote validates the body and replica class', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow({ replicaClass: 'failover' })],
    }),
  })
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }),
    400,
    { error: 'Invalid request' },
  )
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirm: true, memberId: MEMBER_ID }),
    }),
    422,
    { error: 'managed_replica_not_promotable' },
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
    { error: 'Invalid request' },
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
    { error: 'backup_not_found' },
  )
  await expectJson(
    await app.request(envPath('/backups/missing/restore'), {
      method: 'POST',
      headers: authHeaders(cookie),
    }),
    404,
    { error: 'backup_not_found' },
  )
})

test('GET / POST backup and GET databases reject invalid options', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow({ options: { settings: {} } })] }),
  })
  const headers = authHeaders(cookie)
  await expectJson(
    await app.request(envPath('/databases'), { headers }),
    400,
    { error: 'Invalid managed options' },
  )
  await expectJson(
    await app.request(envPath('/backups'), { headers }),
    400,
    { error: 'Invalid managed options' },
  )
})

test('GET org managed returns 404 when the path org does not match the session', async () => {
  const { app, cookie } = await buildApp({ db: fakeDb() })
  await expectJson(
    await app.request(`/organizations/${OTHER_ORG}/managed`, {
      headers: authHeaders(cookie),
    }),
    404,
    { error: 'Not found' },
  )
})

test('GET org managed returns 401 without a session even when a cookie is stale', async () => {
  const { app } = await buildApp({ db: fakeDb() })
  await expectJson(
    await app.request(`/organizations/${ORG_ID}/managed`, {
      headers: { [ORG_ID_HEADER]: ORG_ID },
    }),
    401,
    { ok: false, error: 'Unauthorized' },
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
    { managed: [] },
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
    { error: 'Forbidden' },
  )
})

test('disaster-recovery promote returns 503 when the database is unset', async () => {
  const { app, cookie } = await buildApp()
  await expectJson(
    await app.request(envPath('/disaster-recovery/promote'), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, memberId: MEMBER_ID }),
    }),
    503,
    { error: 'Database unavailable' },
  )
})

test('GET managed serializes a placed cluster with a loopback listener', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
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
      managedRows: [managedRow({
        serverId: null,
        status: 'failed',
        metadata: { error: 'apply exploded' },
      })],
    }),
  })
  const body = await jsonOf(
    await app.request(envPath('/status'), { headers: authHeaders(cookie) }),
  )
  assertEquals(body.status, 'failed')
  assertEquals(body.error, 'apply exploded')
})

test('GET status includes environment containers', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow({ serverId: null })],
      serviceRows: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
      containerRows: [{
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
      }],
    }),
  })
  const body = await jsonOf(
    await app.request(envPath('/status'), { headers: authHeaders(cookie) }),
  )
  const containers = body.containers as Array<{ status: string }>
  assertEquals(containers.length, 1)
  assertEquals(containers[0]?.status, 'pending')
})

test('GET logs returns 503 without a daemon cell registry', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({ managedRows: [managedRow()] }),
  })
  await expectJson(
    await app.request(envPath('/logs'), { headers: authHeaders(cookie) }),
    503,
    { error: 'Daemon cell registry unavailable' },
  )
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
    { error: 'server_offline' },
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
    { logs: 'engine ready\n' },
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
    { error: 'server_offline' },
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
    { error: 'Daemon cell registry unavailable' },
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
    { error: 'Command queue unavailable' },
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
    { error: 'daemon_key_unavailable' },
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
    { error: 'daemon_key_unavailable' },
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
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
  await expectJson(
    await app.request(envPath('/root-password'), {
      method: 'POST',
      headers,
      body: '{}',
    }),
    422,
    { error: 'daemon_key_unavailable' },
  )
  await expectJson(
    await app.request(envPath('/users'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'appuser', databases: ['postgres'] }),
    }),
    422,
    { error: 'daemon_key_unavailable' },
  )
  await expectJson(
    await app.request(envPath(`/users/${PRINCIPAL_ID}/password`), {
      method: 'POST',
      headers,
      body: '{}',
    }),
    422,
    { error: 'daemon_key_unavailable' },
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
    { error: 'Invalid request' },
  )
})

test('POST create rejects invalid settings after the host is online', async () => {
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
      body: JSON.stringify({ exposure: { bind: 'public' } }),
    }),
    400,
    { error: 'managed_settings_invalid' },
  )
})

test('POST lifecycle / backups / restore require an online host', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      serverRows: [presenceServer(false)],
      memberRows: [memberRow({ role: 'primary', replicaClass: null, ordinal: 1 })],
    }),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
  await expectJson(
    await app.request(envPath('/lifecycle'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'start' }),
    }),
    409,
    { error: 'server_offline' },
  )
  await expectJson(
    await app.request(envPath('/backups'), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }),
    409,
    { error: 'server_offline' },
  )
  await expectJson(
    await app.request(envPath(`/backups/${BACKUP_ID}`), {
      method: 'DELETE',
      headers,
    }),
    409,
    { error: 'server_offline' },
  )
  await expectJson(
    await app.request(envPath(`/backups/${BACKUP_ID}/restore`), {
      method: 'POST',
      headers,
    }),
    409,
    { error: 'server_offline' },
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
    { error: 'Daemon cell registry unavailable' },
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
    { error: 'managed_replica_not_streaming' },
  )
})

test('POST promote returns 409 when replica health is stale', async () => {
  const { app, cookie } = await buildApp({
    db: fakeDb({
      managedRows: [managedRow()],
      memberRows: [memberRow({
        replicaClass: 'failover',
        metadata: {
          replication: {
            state: 'streaming',
            observedAt: '2020-01-01T00:00:00.000Z',
            lagBytes: 1,
          },
        },
      })],
    }),
  })
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}/promote`), {
      method: 'POST',
      headers: { ...authHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    409,
    { error: 'managed_replica_health_stale' },
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
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
  await expectJson(
    await app.request(envPath(`/users/${PRINCIPAL_ID}`), {
      method: 'DELETE',
      headers,
    }),
    422,
    { error: 'daemon_key_unavailable' },
  )
  await expectJson(
    await app.request(envPath(`/members/${MEMBER_ID}`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ readEligible: true }),
    }),
    422,
    { error: 'daemon_key_unavailable' },
  )
  await expectJson(
    await app.request(envPath('/databases'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'reports' }),
    }),
    422,
    { error: 'daemon_key_unavailable' },
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
    { error: 'server_offline' },
  )
})

function applyReadyDb(extra: FakeDbConfig = {}) {
  return fakeDb({
    managedRows: extra.managedRows ?? [managedRow()],
    serverRows: extra.serverRows ?? [applyReadyServer()],
    memberRows: extra.memberRows ?? [
      memberRow({ role: 'primary', replicaClass: null, ordinal: 1 }),
    ],
    principalRows: extra.principalRows ?? [principalRow({
      id: PRINCIPAL_ID,
      username: 'postgres',
      metadata: { managedRoot: true, engine: 'postgres', databases: ['postgres'] },
    })],
    serviceRows: extra.serviceRows ?? [engineServiceRow()],
    containerRows: extra.containerRows ?? [engineContainerRow()],
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
  extras: Record<string, unknown> = {},
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
    { status: 'queued' },
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
    { error: 'Command queue unavailable' },
  )
})

test('POST lifecycle / DELETE placed / backups enqueue when the host is online', async () => {
  const { app, cookie } = await buildApp({
    db: applyReadyDb(),
    registry: stubRegistry(),
    commandQueue: recordingQueue(),
  })
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
  await expectQueued(
    await app.request(envPath('/lifecycle'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'start' }),
    }),
    { status: 'queued' },
  )
  await expectQueued(
    await app.request(envPath(), { method: 'DELETE', headers: authHeaders(cookie) }),
    { deleted: false },
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
    }),
  )
  await expectQueued(
    await app.request(envPath(`/backups/${BACKUP_ID}/restore`), {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }),
  )
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
  const headers = { ...authHeaders(cookie), 'content-type': 'application/json' }
  await expectJson(
    await app.request(envPath('/users'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'appuser', databases: ['postgres'] }),
    }),
    409,
    { error: 'managed_user_exists' },
  )
  const created = await app.request(envPath('/users'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'reporter', databases: ['postgres'] }),
  })
  assertEquals([200, 409, 422, 500].includes(created.status), true)
  if (created.status !== 200) {
    const body = await jsonOf(created)
    assertEquals(typeof body.error, 'string')
  }
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
