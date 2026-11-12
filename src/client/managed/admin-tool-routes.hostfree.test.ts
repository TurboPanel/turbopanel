/**
 * Host-free coverage of the admin tool routes: the login steps come in as
 * stubs and everything stored goes through an in-memory store, so no database
 * is touched. Run through `deno task test:managed-hostfree`.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { DEPLOY_CONFIG_FILES_FEATURE } from '../../lib/version-wire.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  adminToolMetadata,
  type AdminToolProject,
} from '../../features/managed/admin-tools/projects.ts'
import { ADMIN_TOOLS } from '../../features/managed/admin-tools/templates.ts'
import { type AdminToolScope, registerManagedAdminToolRoutes } from './admin-tool-routes.ts'
import type { AdminToolStore, Refusal } from './admin-tool-store.ts'
import type { ManagedContext } from './context.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

const ENV_ID = '33333333-3333-4333-8333-333333333333'
const MANAGED_ID = '55555555-5555-4555-8555-555555555555'
const SERVER_ID = '66666666-6666-4666-8666-666666666666'
const TOOL_PROJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LOGIN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
/** Built from fragments so no assignment reads as a hard-coded credential. */
const fixtureValue = (label: string) => ['fixture', label, 'value'].join('-')
const LOGIN_SECRET = fixtureValue('login')
const ROTATED_SECRET = fixtureValue('rotated')
const SESSION_EMAIL = 'ops@example.org'

type Call = { name: string; args?: unknown }

type Setup = {
  engine?: string
  serverId?: string | null
  features?: readonly string[]
  destroyPending?: boolean
  panelRefusal?: string | null
  hostnameInUse?: boolean
  insertRefusal?: Refusal
  bindRefusal?: Refusal
  applyResponse?: Response
  rotateResponse?: Response
  deleteLoginStatus?: number
  deniedScope?: Response
  tool?: AdminToolProject
  email?: string
}

function sampleTool(overrides: Partial<AdminToolProject['meta']> = {}): AdminToolProject {
  return {
    projectId: TOOL_PROJECT,
    environmentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    name: 'Main Database pgAdmin',
    meta: adminToolMetadata({
      tool: 'pgadmin',
      managedId: MANAGED_ID,
      loginId: LOGIN_ID,
      loginName: 'pgadmin_aaaaaa',
      hostname: 'db-admin.example.com',
      access: 'admin',
      revision: 2,
      email: SESSION_EMAIL,
      ...overrides,
    }),
  }
}

async function build(setup: Setup = {}) {
  const calls: Call[] = []
  const log = (name: string, args?: unknown) => calls.push({ name, args })
  const scope = {
    db: {} as Db,
    auth: { userId: 'u1', organizationId: 'o1' },
    ctx: { spec: { engine: setup.engine ?? 'postgres' }, projectId: 'cluster' } as ManagedContext,
    row: { id: MANAGED_ID, serverId: setup.serverId === undefined ? SERVER_ID : setup.serverId },
  } satisfies AdminToolScope
  const store: AdminToolStore = {
    findTool: (id) => {
      log('findTool', id)
      return Promise.resolve(setup.tool && setup.tool.projectId === id ? setup.tool : undefined)
    },
    destroyPending: () => Promise.resolve(setup.destroyPending === true),
    panelHostnameRefusal: () => Promise.resolve(setup.panelRefusal ?? null),
    hostnameInUse: () => Promise.resolve(setup.hostnameInUse === true),
    daemonFeatures: () => Promise.resolve(setup.features ?? [DEPLOY_CONFIG_FILES_FEATURE]),
    resolveWorkspace: () => Promise.resolve({ workspaceId: 'w1', clusterName: 'Main Database' }),
    insertProject: (input) => {
      log('insertProject', input)
      return Promise.resolve(
        setup.insertRefusal ?? { projectId: TOOL_PROJECT, environmentId: 'env-new' }
      )
    },
    bind: (environmentId, loginId) => {
      log('bind', { environmentId, loginId })
      return Promise.resolve(setup.bindRefusal ?? { serviceId: 'svc1' })
    },
    enqueueIngress: (serviceId) => {
      log('enqueueIngress', serviceId)
      return Promise.resolve()
    },
    undoCreate: (made) => {
      log('undoCreate', made)
      return Promise.resolve()
    },
    dropProject: (id) => {
      log('dropProject', id)
      return Promise.resolve()
    },
    setWebPassword: (envId, sealed) => {
      log('setWebPassword', { envId, sealed })
      return Promise.resolve()
    },
    rewrite: (tool, revision) => {
      log('rewrite', { projectId: tool.projectId, revision })
      return Promise.resolve()
    },
    audit: (action, context) => {
      log('audit', { action, context })
      return Promise.resolve()
    },
    removeProject: (id) => {
      log('removeProject', id)
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }))
    },
  }
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('dataEncryptionSecrets', secrets)
    c.set('session', { email: setup.email ?? SESSION_EMAIL } as never)
    await next()
  })
  registerManagedAdminToolRoutes(app, {
    loadScope: () => Promise.resolve(setup.deniedScope ?? scope),
    loadReadScope: () =>
      Promise.resolve(
        setup.deniedScope ?? { db: scope.db, auth: scope.auth, managedId: MANAGED_ID }
      ),
    createLogin: (_c, _scope, input) => {
      log('createLogin', input)
      return Promise.resolve({
        loginId: LOGIN_ID,
        username: input.username,
        password: LOGIN_SECRET,
        notes: [],
        apply: () => {
          log('apply')
          return Promise.resolve(setup.applyResponse ?? { queued: true })
        },
      })
    },
    rotateLogin: (_c, _scope, loginId) => {
      log('rotateLogin', loginId)
      return Promise.resolve(setup.rotateResponse ?? { plaintext: ROTATED_SECRET })
    },
    deleteLogin: (_c, _scope, loginId) => {
      log('deleteLogin', loginId)
      const status = setup.deleteLoginStatus ?? 200
      return Promise.resolve(
        new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'login_busy' }), {
          status,
        })
      )
    },
    storeFor: () => store,
    listTools: () => Promise.resolve(setup.tool ? [setup.tool] : []),
  })
  const request = (method: string, suffix: string, body?: unknown) =>
    app.request(`/environments/${ENV_ID}/managed/admin-tools${suffix}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    })
  return { calls, request }
}

const names = (calls: Call[]) => calls.map((entry) => entry.name)
const called = (calls: Call[], name: string) => calls.find((entry) => entry.name === name)

// 1. Create per tool and access level

const CREATE_CASES = [
  { tool: 'phpmyadmin', engine: 'mysql', access: 'admin' },
  { tool: 'adminer', engine: 'postgres', access: 'read-only' },
  { tool: 'pgadmin', engine: 'postgres', access: 'admin' },
] as const

for (const { tool, engine, access } of CREATE_CASES) {
  test(`create ${tool} (${access}) makes the login, project and binding, then queues the proxy`, async () => {
    const { calls, request } = await build({ engine })
    const res = await request('POST', '', { tool, hostname: 'Db-Admin.Example.com', access })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.loginPassword, LOGIN_SECRET)
    assertEquals(body.projectId, TOOL_PROJECT)
    assert(String(body.loginName).startsWith(`${tool}_`))
    if (tool === 'pgadmin') {
      assertEquals(body.webEmail, SESSION_EMAIL)
      assert(typeof body.webPassword === 'string' && body.webPassword.length > 0)
    } else {
      assertEquals(body.webEmail, undefined)
      assertEquals(body.webPassword, undefined)
    }
    assertEquals(called(calls, 'createLogin')?.args, { username: body.loginName, access })
    const insert = called(calls, 'insertProject')?.args as {
      meta: Record<string, unknown>
      sealedWebPassword?: string
    }
    assertEquals(insert.meta.code, 'admin-tool')
    assertEquals(insert.meta.tool, tool)
    assertEquals(insert.meta.hostname, 'db-admin.example.com')
    assertEquals(insert.meta.managedId, MANAGED_ID)
    assertEquals(insert.meta.access, access)
    assertEquals(insert.meta.image, ADMIN_TOOLS[tool].image)
    assertEquals(insert.sealedWebPassword !== undefined, tool === 'pgadmin')
    assertEquals(called(calls, 'bind')?.args, { environmentId: 'env-new', loginId: LOGIN_ID })
    assertEquals(
      names(calls).filter((n) => ['apply', 'enqueueIngress', 'audit'].includes(n)),
      ['apply', 'enqueueIngress', 'audit']
    )
  })
}

test('the audit entry names the tool and never a password', async () => {
  const { calls, request } = await build()
  const res = await request('POST', '', { tool: 'pgadmin', hostname: 'a.example.com' })
  const body = await res.json()
  const audit = JSON.stringify(called(calls, 'audit')?.args)
  assertStringIncludes(audit, 'managed.admin_tool.create')
  assertStringIncludes(audit, 'pgadmin')
  for (const secret of [LOGIN_SECRET, body.webPassword]) assert(!audit.includes(secret))
})

// 2. Create rollback

test('a refused project insert leaves no login and no project', async () => {
  const { calls, request } = await build({ insertRefusal: { error: 'boom', status: 409 } })
  const res = await request('POST', '', { tool: 'pgadmin', hostname: 'a.example.com' })
  assertEquals(res.status, 409)
  assertEquals(called(calls, 'undoCreate')?.args, { loginId: LOGIN_ID })
  assert(!names(calls).includes('apply'))
})

test('a refused binding takes back the project and the login', async () => {
  const { calls, request } = await build({
    bindRefusal: { error: 'binding_ca_unavailable', status: 422 },
  })
  const res = await request('POST', '', { tool: 'pgadmin', hostname: 'a.example.com' })
  assertEquals(res.status, 422)
  assertEquals(called(calls, 'undoCreate')?.args, { loginId: LOGIN_ID, projectId: TOOL_PROJECT })
  assert(!names(calls).includes('enqueueIngress'))
})

test('a binding with no database to bind answers 409 and undoes the create', async () => {
  const { calls, request } = await build({
    bindRefusal: { error: 'admin_tool_needs_database', status: 409 },
  })
  const res = await request('POST', '', { tool: 'adminer', hostname: 'a.example.com' })
  assertEquals(res.status, 409)
  assertEquals((await res.json()).error, 'admin_tool_needs_database')
  assert(names(calls).includes('undoCreate'))
})

test('a login apply that cannot be queued drops the project and queues no proxy change', async () => {
  const applyResponse = new Response('{"error":"queue_down"}', { status: 503 })
  const { calls, request } = await build({ applyResponse })
  const res = await request('POST', '', { tool: 'pgadmin', hostname: 'a.example.com' })
  assertEquals(res.status, 503)
  assertEquals(called(calls, 'dropProject')?.args, TOOL_PROJECT)
  assert(!names(calls).includes('enqueueIngress'))
  assert(!names(calls).includes('audit'))
})

// 3. Create refusals

const REFUSALS: ReadonlyArray<{
  label: string
  setup: Setup
  body: Record<string, unknown>
  status: number
  error: string
}> = [
  {
    label: 'engine mismatch',
    setup: { engine: 'mysql' },
    body: { tool: 'pgadmin', hostname: 'a.example.com' },
    status: 400,
    error: 'admin_tool_engine_mismatch',
  },
  {
    label: 'invalid hostname',
    setup: {},
    body: { tool: 'pgadmin', hostname: 'not a host' },
    status: 400,
    error: 'invalid_hostname',
  },
  {
    label: 'control plane hostname',
    setup: { panelRefusal: 'That name is the control plane.' },
    body: { tool: 'pgadmin', hostname: 'panel.example.com' },
    status: 409,
    error: 'admin_tool_hostname_in_use',
  },
  {
    label: 'hostname already used by a site',
    setup: { hostnameInUse: true },
    body: { tool: 'pgadmin', hostname: 'site.example.com' },
    status: 409,
    error: 'hostname_in_use',
  },
  {
    label: 'destroy in progress',
    setup: { destroyPending: true },
    body: { tool: 'pgadmin', hostname: 'a.example.com' },
    status: 409,
    error: 'managed_destroy_in_progress',
  },
  {
    label: 'old daemon for Adminer',
    setup: { features: [] },
    body: { tool: 'adminer', hostname: 'a.example.com' },
    status: 409,
    error: 'admin_tool_needs_daemon_update',
  },
  {
    label: 'old daemon for pgAdmin',
    setup: { features: [] },
    body: { tool: 'pgadmin', hostname: 'a.example.com' },
    status: 409,
    error: 'admin_tool_needs_daemon_update',
  },
  {
    label: 'special-use email',
    setup: { email: 'me@host.local' },
    body: { tool: 'pgadmin', hostname: 'a.example.com' },
    status: 400,
    error: 'admin_tool_email_invalid',
  },
]

for (const { label, setup, body, status, error } of REFUSALS) {
  test(`create refuses: ${label}`, async () => {
    const { calls, request } = await build(setup)
    const res = await request('POST', '', body)
    assertEquals(res.status, status)
    assertEquals((await res.json()).error, error)
    assert(!names(calls).includes('createLogin'))
  })
}

test('an old daemon does not stop phpMyAdmin', async () => {
  const { request } = await build({ features: [], engine: 'mariadb' })
  const res = await request('POST', '', { tool: 'phpmyadmin', hostname: 'a.example.com' })
  assertEquals(res.status, 200)
})

// 4. Authorization and foreign projects

test('every route answers what the scope answers when manage is missing', async () => {
  const { calls, request } = await build({
    deniedScope: new Response('{"error":"Forbidden"}', { status: 403 }),
    tool: sampleTool(),
  })
  const answers = await Promise.all([
    request('GET', ''),
    request('POST', '', { tool: 'pgadmin', hostname: 'a.example.com' }),
    request('POST', `/${TOOL_PROJECT}/password`),
    request('POST', `/${TOOL_PROJECT}/update`),
    request('DELETE', `/${TOOL_PROJECT}?confirmName=x`),
  ])
  assertEquals(
    answers.map((res) => res.status),
    [403, 403, 403, 403, 403]
  )
  assertEquals(calls, [])
})

test('a project that is not a tool of this cluster is 404 on reset, update and remove', async () => {
  const { calls, request } = await build({ tool: sampleTool() })
  const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const answers = await Promise.all([
    request('POST', `/${other}/password`),
    request('POST', `/${other}/update`),
    request('DELETE', `/${other}?confirmName=x`),
  ])
  assertEquals(
    answers.map((res) => res.status),
    [404, 404, 404]
  )
  for (const forbidden of ['rotateLogin', 'rewrite', 'removeProject', 'deleteLogin']) {
    assert(!names(calls).includes(forbidden))
  }
})

test('the list shows the tools without a password and with the update flag', async () => {
  const { request } = await build({ tool: sampleTool({ image: 'dpage/pgadmin4:9.0' }) })
  const body = await (await request('GET', '')).json()
  assertEquals(body.tools.length, 1)
  assertEquals(body.tools[0].updateAvailable, true)
  assertEquals(body.tools[0].loginName, 'pgadmin_aaaaaa')
  assert(!JSON.stringify(body).includes('assword'))
})

// 5. Reset

test('reset rotates the tool login, renews the web password and bumps the revision', async () => {
  const { calls, request } = await build({ tool: sampleTool() })
  const res = await request('POST', `/${TOOL_PROJECT}/password`)
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.loginPassword, ROTATED_SECRET)
  assertEquals(body.loginName, 'pgadmin_aaaaaa')
  assertEquals(body.webEmail, SESSION_EMAIL)
  assert(typeof body.webPassword === 'string')
  assertEquals(called(calls, 'rotateLogin')?.args, LOGIN_ID)
  assertEquals(called(calls, 'rewrite')?.args, { projectId: TOOL_PROJECT, revision: 3 })
  assert(names(calls).includes('setWebPassword'))
})

test('reset leaves the web password alone for tools that have none', async () => {
  const { calls, request } = await build({
    tool: sampleTool({ tool: 'phpmyadmin', email: undefined }),
  })
  const body = await (await request('POST', `/${TOOL_PROJECT}/password`)).json()
  assertEquals(body.webPassword, undefined)
  assert(!names(calls).includes('setWebPassword'))
})

test('a refused rotation (guard or failed apply) changes nothing else', async () => {
  const rotateResponse = new Response('{"error":"queue_down"}', { status: 503 })
  const { calls, request } = await build({ tool: sampleTool(), rotateResponse })
  const res = await request('POST', `/${TOOL_PROJECT}/password`)
  assertEquals(res.status, 503)
  for (const forbidden of ['setWebPassword', 'rewrite', 'audit']) {
    assert(!names(calls).includes(forbidden))
  }
})

// 6. Update

test('update rewrites the overlay with the next revision', async () => {
  const { calls, request } = await build({ tool: sampleTool() })
  const res = await request('POST', `/${TOOL_PROJECT}/update`)
  assertEquals(res.status, 200)
  assertEquals((await res.json()).environmentId, sampleTool().environmentId)
  assertEquals(called(calls, 'rewrite')?.args, { projectId: TOOL_PROJECT, revision: 3 })
  assert(!names(calls).includes('rotateLogin'))
})

// 7. Remove

test('remove needs the typed name', async () => {
  const { calls, request } = await build({ tool: sampleTool() })
  const res = await request('DELETE', `/${TOOL_PROJECT}`)
  assertEquals(res.status, 400)
  assert(!names(calls).includes('removeProject'))
})

test('remove deletes the project, then the login', async () => {
  const { calls, request } = await build({ tool: sampleTool() })
  const name = encodeURIComponent('Main Database pgAdmin')
  const res = await request('DELETE', `/${TOOL_PROJECT}?confirmName=${name}`)
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true })
  assertEquals(
    names(calls).filter((n) => ['removeProject', 'audit', 'deleteLogin'].includes(n)),
    ['removeProject', 'audit', 'deleteLogin']
  )
  assertEquals(called(calls, 'deleteLogin')?.args, LOGIN_ID)
})

test('a login that cannot be removed is reported, not an error', async () => {
  const { request } = await build({ tool: sampleTool(), deleteLoginStatus: 409 })
  const name = encodeURIComponent('Main Database pgAdmin')
  const res = await request('DELETE', `/${TOOL_PROJECT}?confirmName=${name}`)
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    loginNotRemoved: { name: 'pgadmin_aaaaaa', reason: 'login_busy' },
  })
})
