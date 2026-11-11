/**
 * The database-backed admin tool store against a scripted stand-in for the
 * query builder: each table answers the rows a test gives it, and every write
 * is recorded. Run through `deno task test:managed-hostfree`.
 */

import { assert, assertEquals } from '@std/assert'
import { getTableName } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { adminToolMetadata } from '../../features/managed/admin-tools/projects.ts'
import type { ManagedContext } from './context.ts'
import { type AdminToolScope, createDbAdminToolStore } from './admin-tool-store.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

type Row = Record<string, unknown>
type Write = { kind: string; table: string; values?: unknown }

/** A query builder stand-in: `select` answers `rows[table]`, `insert ... returning` answers `inserted[table]`. */
function fakeDb(rows: Record<string, Row[]>, inserted: Record<string, Row[]> = {}) {
  const writes: Write[] = []
  const make = (kind: string, table: unknown) => {
    const state: Write = { kind, table: table ? getTableName(table as never) : '' }
    const proxy: unknown = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          const answer =
            kind === 'select'
              ? (rows[state.table] ?? [])
              : kind === 'insert'
                ? (inserted[state.table] ?? [{ id: `new-${state.table}` }])
                : []
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(answer).then(resolve, reject)
        }
        if (prop === 'from') {
          return (from: unknown) => {
            state.table = getTableName(from as never)
            return proxy
          }
        }
        if (prop === 'values' || prop === 'set') {
          return (values: unknown) => {
            state.values = values
            if (kind !== 'select') writes.push(state)
            return proxy
          }
        }
        return () => proxy
      },
    })
    if (kind === 'delete') writes.push(state)
    return proxy
  }
  const db: Record<string, unknown> = {
    select: () => make('select', null),
    insert: (table: unknown) => make('insert', table),
    update: (table: unknown) => make('update', table),
    delete: (table: unknown) => make('delete', table),
  }
  db.execute = () => Promise.resolve([])
  db.transaction = (fn: (tx: unknown) => Promise<unknown>) => fn(db)
  return { db: db as unknown as Db, writes }
}

const MANAGED_ID = '55555555-5555-4555-8555-555555555555'
const LOGIN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PROJECT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function context(values: Record<string, unknown> = {}): Context<AppEnv> {
  return {
    get: (key: string) => values[key],
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context<AppEnv>
}

function storeFor(db: Db, values: Record<string, unknown> = {}) {
  const scope: AdminToolScope = {
    db,
    auth: { userId: 'u1', organizationId: 'o1' },
    ctx: { spec: { engine: 'postgres' }, projectId: 'cluster' } as ManagedContext,
    row: { id: MANAGED_ID, serverId: 's1' },
  }
  return createDbAdminToolStore(context(values), scope)
}

function toolRow(overrides: Row = {}): Row {
  return {
    projectId: PROJECT_ID,
    name: 'Main Database pgAdmin',
    environmentId: 'env-1',
    loginId: LOGIN_ID,
    metadata: adminToolMetadata({
      tool: 'pgadmin',
      managedId: MANAGED_ID,
      loginId: 'copied-login',
      loginName: 'pgadmin_aaaaaa',
      hostname: 'db-admin.example.com',
      access: 'admin',
      revision: 2,
      email: 'ops@example.org',
    }),
    ...overrides,
  }
}

test('findTool answers the tool whose binding names its login, and nothing for another project', async () => {
  const { db } = fakeDb({ project: [toolRow()] })
  const store = storeFor(db)
  const found = await store.findTool(PROJECT_ID)
  assertEquals(found?.meta.loginId, LOGIN_ID)
  assertEquals(await store.findTool('other-project'), undefined)
})

test('a pending destroy, a used hostname and the daemon features are read from their tables', async () => {
  const pending = storeFor(fakeDb({ command: [{ id: 'c1' }] }).db)
  assertEquals(await pending.destroyPending(), true)
  assertEquals(await storeFor(fakeDb({}).db).destroyPending(), false)
  assertEquals(
    await storeFor(fakeDb({ hostname: [{ id: 'h1' }] }).db).hostnameInUse('a.example.com'),
    true
  )
  assertEquals(await storeFor(fakeDb({}).db).hostnameInUse('a.example.com'), false)
  assertEquals(await storeFor(fakeDb({}).db).daemonFeatures('s1'), [])
  assertEquals(await storeFor(fakeDb({}).db).panelHostnameRefusal('a.example.com'), null)
})

test('the web password, the audit entry and the login row are written to their tables', async () => {
  const { db, writes } = fakeDb({})
  const store = storeFor(db)
  await store.setWebPassword('env-1', 'sealed-value')
  await store.audit('managed.admin_tool.update', { projectId: PROJECT_ID })
  await store.undoCreate({ loginId: LOGIN_ID })
  const tables = writes.map((write) => `${write.kind} ${write.table}`)
  assert(tables.includes('update variable'), tables.join(', '))
  assert(tables.includes('insert audit'), tables.join(', '))
  assert(tables.includes('delete login'), tables.join(', '))
})

test('enqueueIngress does nothing when the request has no command queue or secrets', async () => {
  const store = storeFor(fakeDb({}).db)
  await store.enqueueIngress('svc-1')
})

test('bind answers 503 without the encryption secrets', async () => {
  const store = storeFor(fakeDb({}).db)
  const result = await store.bind('env-1', LOGIN_ID)
  assertEquals(result, { error: 'Encryption unavailable', status: 503 })
})

test('bind refuses when the tool service or a database to bind is missing', async () => {
  const secrets = { derived: true }
  const noService = storeFor(fakeDb({ service: [] }).db, { dataEncryptionSecrets: secrets })
  assertEquals(await noService.bind('env-1', LOGIN_ID), {
    error: 'admin_tool_service_missing',
    status: 500,
  })
  const noDatabase = storeFor(fakeDb({ service: [{ id: 'svc-1' }], database: [] }).db, {
    dataEncryptionSecrets: secrets,
  })
  assertEquals(await noDatabase.bind('env-1', LOGIN_ID), {
    error: 'admin_tool_needs_database',
    status: 409,
  })
})

test('bind takes the binding back when its variables cannot be written', async () => {
  const { db, writes } = fakeDb({
    service: [{ id: 'svc-1' }],
    database: [{ id: 'db-1', name: 'shop' }],
  })
  const store = storeFor(db, { dataEncryptionSecrets: { derived: true } })
  const result = await store.bind('env-1', LOGIN_ID)
  assert('error' in result)
  assertEquals(result.status, 422)
  const tables = writes.map((write) => `${write.kind} ${write.table}`)
  assert(tables.includes('insert binding'), tables.join(', '))
  assert(tables.includes('delete binding'), tables.join(', '))
})

test('insertProject makes the project and environment, and stores the sealed web password once', async () => {
  const { db, writes } = fakeDb(
    { environment: [{ id: 'env-1' }] },
    { project: [{ id: PROJECT_ID }], environment: [{ id: 'env-1' }] }
  )
  const store = storeFor(db)
  const meta = toolRow().metadata as ReturnType<typeof adminToolMetadata>
  const made = await store.insertProject({
    tool: 'pgadmin',
    meta,
    serverId: 's1',
    email: 'ops@example.org',
    sealedWebPassword: 'sealed-web-value',
    workspaceId: 'w1',
    clusterName: 'Main Database',
  })
  assertEquals(made, { projectId: PROJECT_ID, environmentId: 'env-1' })
  const variables = writes.filter((write) => write.table === 'variable')
  assertEquals(variables.length, 1)
  assertEquals((variables[0].values as Row).key, 'TOOL_WEB_PASSWORD')
  assertEquals((variables[0].values as Row).isSecret, true)
})

test('insertProject stores no variable for a tool without a web password', async () => {
  const { db, writes } = fakeDb(
    { environment: [{ id: 'env-1' }] },
    { project: [{ id: PROJECT_ID }], environment: [{ id: 'env-1' }] }
  )
  const meta = adminToolMetadata({
    tool: 'adminer',
    managedId: MANAGED_ID,
    loginId: LOGIN_ID,
    loginName: 'adminer_aaaaaa',
    hostname: 'a.example.com',
    access: 'read-only',
    revision: 1,
  })
  await storeFor(db).insertProject({
    tool: 'adminer',
    meta,
    serverId: 's1',
    email: undefined,
    sealedWebPassword: undefined,
    workspaceId: 'w1',
    clusterName: null,
  })
  assertEquals(
    writes.filter((write) => write.table === 'variable'),
    []
  )
})

test('rewrite stores the next compose overlay and the new revision and image', async () => {
  const { db, writes } = fakeDb({ environment: [{ options: null }] })
  const store = storeFor(db)
  const tool = await storeFor(fakeDb({ project: [toolRow()] }).db).findTool(PROJECT_ID)
  assert(tool)
  await store.rewrite({ ...tool, meta: { ...tool.meta, image: 'dpage/pgadmin4:9.0' } }, 3)
  const project = writes.find((write) => write.kind === 'update' && write.table === 'project')
  const metadata = (project?.values as Row).metadata as Record<string, unknown>
  assertEquals(metadata.revision, 3)
  assertEquals(metadata.image, 'dpage/pgadmin4:9.19')
  const env = writes.find((write) => write.kind === 'update' && write.table === 'environment')
  assert(JSON.stringify((env?.values as Row).options).includes('ADMIN_TOOL_REVISION'))
})
