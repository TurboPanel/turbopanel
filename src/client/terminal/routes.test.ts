/**
 * Container terminal routes against a real database and a recording cell:
 * the gate order, the open answer, the audit trail, the session list and kill,
 * and the server's own switch.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertNotEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  audit,
  container,
  environment,
  grant,
  organization,
  project,
  server,
  service,
  user,
  workspace,
} from '../../db/schema.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { base64urlEncode } from '../../lib/encoding/base64url.ts'
import { TERMINAL_CONTAINER_FEATURE } from '../../lib/version-wire.ts'
import type {
  DaemonCell,
  DaemonCellRegistry,
  ShellKillReason,
  ShellOpenRequest,
  ShellOpenResult,
  ShellSessionInfo,
} from '../../contracts/cell.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerServerRoutes } from '../servers/routes.ts'
import { registerTerminalRoutes } from './routes.ts'
import { verifyShellTicket } from '../../features/terminal/ticket.ts'

const dbUrl = getDatabaseUrl()

/** Alias Sonar recognizes as a test declaration. */
const test = Deno.test.bind(Deno)

type FakeCellOptions = {
  openResult?: ShellOpenResult
  withShellApi?: boolean
  sessions?: ShellSessionInfo[]
}

function createFakeRegistry(options: FakeCellOptions) {
  const opened: ShellOpenRequest[] = []
  const killed: { sid?: string; all?: true; reason: ShellKillReason }[] = []
  const cell = {
    ...(options.withShellApi === false
      ? {}
      : {
          shellOpen: (request: ShellOpenRequest) => {
            opened.push(request)
            return Promise.resolve(
              options.openResult ?? { ok: true as const, expiresAtMs: Date.now() + 30_000 }
            )
          },
          shellList: () => Promise.resolve(options.sessions ?? []),
          shellKill: (params: { sid?: string; all?: true; reason: ShellKillReason }) => {
            killed.push(params)
            return Promise.resolve(
              params.all ? (options.sessions?.length ?? 0) : options.sessions?.length ? 1 : 0
            )
          },
        }),
  } as unknown as DaemonCell
  const registry = {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  } as unknown as DaemonCellRegistry
  return { registry, opened, killed }
}

type Fixtures = {
  db: ReturnType<typeof createDenoDb>
  app: Hono<AppEnv>
  cookie: string
  organizationId: string
  serverId: string
  containerRowId: string
  userId: string
  userEmail: string
  headers: Record<string, string>
  opened: ShellOpenRequest[]
  killed: { sid?: string; all?: true; reason: ShellKillReason }[]
  ticketKeyring: Awaited<ReturnType<typeof deriveSecretsConfig>>
}

async function withTerminalFixtures(
  options: FakeCellOptions & {
    switchOn?: boolean
    feature?: boolean
    sealing?: boolean
    containerStatus?: string
    containerRole?: string
    withTicketSecrets?: boolean
  },
  fn: (ctx: Fixtures) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('terminal route tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const ticketKeyring = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'shell-ticket')
  const { registry, opened, killed } = createFakeRegistry(options)
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', registry)
    return next()
  })
  const routeOpts = {
    secrets,
    runtime: 'deno' as const,
    signupEnvOverride: undefined,
    ...(options.withTicketSecrets === false ? {} : { shellTicketSecrets: ticketKeyring }),
  }
  registerServerRoutes(app, routeOpts)
  registerTerminalRoutes(app, routeOpts)

  const [org] = await db
    .insert(organization)
    .values({ name: 'Terminal Test Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const userEmail = `terminal-${crypto.randomUUID()}@example.com`
  const [usr] = await db
    .insert(user)
    .values({ email: userEmail, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = usr!.id
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Terminal Workspace', organizationId })
    .returning({ id: workspace.id })
  const now = new Date().toISOString()
  const sealingPair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const sealingPub = base64urlEncode(
    new Uint8Array(await crypto.subtle.exportKey('raw', sealingPair.publicKey))
  )
  const [srv] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Terminal Host',
      options: options.switchOn === false ? null : { terminal: { container: true } },
      daemon: {
        projection: { features: options.feature === false ? [] : [TERMINAL_CONTAINER_FEATURE] },
      },
      ...(options.sealing === false
        ? {}
        : { sealingKeyKid: 'kid-1', sealingKeyPub: sealingPub, sealingKeyReportedAt: now }),
    })
    .returning({ id: server.id })
  const serverId = srv!.id
  const [prj] = await db
    .insert(project)
    .values({ name: 'Shop', workspaceId: ws!.id, organizationId })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ name: 'production', projectId: prj!.id, serverId })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({ name: 'web', environmentId: env!.id, composeServiceName: 'web' })
    .returning({ id: service.id })
  const [ctr] = await db
    .insert(container)
    .values({
      serviceId: svc!.id,
      serverId,
      containerName: 'shop-web-1',
      composeServiceName: 'web',
      status: options.containerStatus ?? 'running',
      role: options.containerRole ?? 'service',
      containerId: 'docker-abc123',
    })
    .returning({ id: container.id })

  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`
  try {
    await fn({
      db,
      app,
      cookie,
      organizationId,
      serverId,
      containerRowId: ctr!.id,
      userId,
      userEmail,
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
      opened,
      killed,
      ticketKeyring,
    })
  } finally {
    await db.delete(audit).where(eq(audit.organizationId, organizationId))
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(service).where(inArray(service.environmentId, [env!.id]))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(project).where(eq(project.id, prj!.id))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(grant).where(and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

function postOpen(ctx: Fixtures, body: Record<string, unknown>) {
  return ctx.app.request(`/servers/${ctx.serverId}/terminal-sessions`, {
    method: 'POST',
    headers: { ...ctx.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function auditActions(ctx: Fixtures): Promise<string[]> {
  const rows = await ctx.db
    .select({ action: audit.action })
    .from(audit)
    .where(eq(audit.organizationId, ctx.organizationId))
  return rows.map((row) => row.action).sort()
}

test('opens a terminal: answer, cell request, audit row and a verifiable ticket', async () => {
  await withTerminalFixtures({}, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId, cols: 100, rows: 30 })
    assertEquals(res.status, 201)
    assertEquals(res.headers.get('Cache-Control'), 'no-store')
    const body = (await res.json()) as Record<string, unknown>
    assertEquals(body.ok, true)
    assertEquals(body.protocol, 'tp-shell.v1')
    assertEquals(body.wsUrl, `/ws/client/v1/shell/${body.sid}`)
    assertEquals(typeof body.key, 'string')

    assertEquals(ctx.opened.length, 1)
    const request = ctx.opened[0]!
    assertEquals(request.sid, body.sid)
    assertEquals(request.containerId, 'docker-abc123')
    assertEquals(request.userId, ctx.userId)
    assertEquals(request.cols, 100)
    assertEquals(request.rows, 30)
    assertNotEquals(request.keySealed, body.key)

    const verdict = await verifyShellTicket(ctx.ticketKeyring, body.ticket as string)
    assertEquals(verdict.ok, true)
    assertEquals(await auditActions(ctx), ['server.terminal.open'])
  })
})

test('open validates the body before anything else runs', async () => {
  await withTerminalFixtures({}, async (ctx) => {
    const cases: Record<string, unknown>[] = [
      { kind: 'host', containerId: ctx.containerRowId },
      { containerId: 'not-a-uuid' },
      { containerId: ctx.containerRowId, user: 'bad user!' },
      { containerId: ctx.containerRowId, cols: 0 },
      { containerId: ctx.containerRowId, rows: 100000 },
    ]
    for (const body of cases) {
      const res = await postOpen(ctx, body)
      assertEquals(res.status, 400, JSON.stringify(body))
      await res.body?.cancel()
    }
    assertEquals(ctx.opened.length, 0)
  })
})

test('open answers 404 for a server outside the organization or a malformed id', async () => {
  await withTerminalFixtures({}, async (ctx) => {
    const bad = await ctx.app.request('/servers/not-a-uuid/terminal-sessions', {
      method: 'POST',
      headers: { ...ctx.headers, 'Content-Type': 'application/json' },
      body: '{}',
    })
    assertEquals(bad.status, 404)
    await bad.body?.cancel()
    const other = await ctx.app.request(`/servers/${crypto.randomUUID()}/terminal-sessions`, {
      method: 'POST',
      headers: { ...ctx.headers, 'Content-Type': 'application/json' },
      body: '{}',
    })
    assertEquals(other.status, 404)
    await other.body?.cancel()
  })
})

test('open is refused while the server switch is off, and writes no audit row', async () => {
  await withTerminalFixtures({ switchOn: false }, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId })
    assertEquals(res.status, 403)
    assertEquals(((await res.json()) as { code: string }).code, 'terminal_disabled')
    assertEquals(ctx.opened.length, 0)
    assertEquals(await auditActions(ctx), [])
  })
})

test('open answers 409 for a stopped container and for a daemon without the feature', async () => {
  await withTerminalFixtures({ containerStatus: 'exited' }, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId })
    assertEquals(res.status, 409)
    assertEquals(((await res.json()) as { code: string }).code, 'container_not_running')
  })
  await withTerminalFixtures({ feature: false }, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId })
    assertEquals(res.status, 409)
    assertEquals(((await res.json()) as { code: string }).code, 'daemon_feature_missing')
  })
})

test('open answers 404 for an unknown container and for a non-service role', async () => {
  await withTerminalFixtures({}, async (ctx) => {
    const res = await postOpen(ctx, { containerId: crypto.randomUUID() })
    assertEquals(res.status, 404)
    assertEquals(((await res.json()) as { code: string }).code, 'container_not_found')
  })
  await withTerminalFixtures({ containerRole: 'ingress' }, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId })
    assertEquals(res.status, 404)
    await res.body?.cancel()
  })
})

test('open answers 503 without ticket secrets and 501 on a cell with no shell hub', async () => {
  await withTerminalFixtures({ withTicketSecrets: false }, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId })
    assertEquals(res.status, 503)
    await res.body?.cancel()
  })
  await withTerminalFixtures({ withShellApi: false }, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId })
    assertEquals(res.status, 501)
    assertEquals(((await res.json()) as { code: string }).code, 'terminal_unsupported')
    assertEquals(await auditActions(ctx), [])
  })
})

test('open needs a registered sealing key and writes no audit row without it', async () => {
  await withTerminalFixtures({ sealing: false }, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId })
    assertEquals(res.status, 409)
    assertEquals(((await res.json()) as { code: string }).code, 'sealing_unavailable')
    assertEquals(await auditActions(ctx), [])
  })
})

test('a refused open closes its own audit row; a send failure is a 502', async () => {
  await withTerminalFixtures({ openResult: { ok: false, code: 'daemon_offline' } }, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId })
    assertEquals(res.status, 409)
    assertEquals(((await res.json()) as { code: string }).code, 'daemon_offline')
    assertEquals(await auditActions(ctx), ['server.terminal.close', 'server.terminal.open'])
  })
  await withTerminalFixtures({ openResult: { ok: false, code: 'send_failed' } }, async (ctx) => {
    const res = await postOpen(ctx, { containerId: ctx.containerRowId })
    assertEquals(res.status, 502)
    await res.body?.cancel()
  })
})

function sessionInfo(sid: string, userId: string): ShellSessionInfo {
  return {
    sid,
    userId,
    kind: 'container',
    containerId: 'docker-abc123',
    loginUser: '',
    state: 'connected',
    openedAtMs: Date.now(),
    maxAtMs: Date.now() + 60_000,
  }
}

test('list shows a manager every session and DELETE ends one', async () => {
  const sid = crypto.randomUUID()
  const other = crypto.randomUUID()
  await withTerminalFixtures(
    { sessions: [sessionInfo(sid, crypto.randomUUID()), sessionInfo(other, crypto.randomUUID())] },
    async (ctx) => {
      const listed = await ctx.app.request(`/servers/${ctx.serverId}/terminal-sessions`, {
        headers: ctx.headers,
      })
      assertEquals(listed.status, 200)
      const body = (await listed.json()) as { sessions: ShellSessionInfo[] }
      assertEquals(body.sessions.length, 2)

      const ended = await ctx.app.request(`/servers/${ctx.serverId}/terminal-sessions/${sid}`, {
        method: 'DELETE',
        headers: ctx.headers,
      })
      assertEquals(ended.status, 200)
      assertEquals(((await ended.json()) as { ended: boolean }).ended, true)
      assertEquals(ctx.killed, [{ sid, reason: 'revoked' }])

      const unknown = await ctx.app.request(
        `/servers/${ctx.serverId}/terminal-sessions/${crypto.randomUUID()}`,
        { method: 'DELETE', headers: ctx.headers }
      )
      assertEquals(unknown.status, 404)
      await unknown.body?.cancel()
      const malformed = await ctx.app.request(
        `/servers/${ctx.serverId}/terminal-sessions/not-a-sid`,
        { method: 'DELETE', headers: ctx.headers }
      )
      assertEquals(malformed.status, 404)
      await malformed.body?.cancel()
    }
  )
})

test('list is empty and DELETE is 404 on a cell with no shell hub', async () => {
  await withTerminalFixtures({ withShellApi: false }, async (ctx) => {
    const listed = await ctx.app.request(`/servers/${ctx.serverId}/terminal-sessions`, {
      headers: ctx.headers,
    })
    assertEquals(((await listed.json()) as { sessions: unknown[] }).sessions, [])
    const res = await ctx.app.request(
      `/servers/${ctx.serverId}/terminal-sessions/${crypto.randomUUID()}`,
      { method: 'DELETE', headers: ctx.headers }
    )
    assertEquals(res.status, 404)
    await res.body?.cancel()
  })
})

test('PUT /terminal flips the switch, audits it and ends open sessions when turned off', async () => {
  await withTerminalFixtures({ sessions: [sessionInfo(crypto.randomUUID(), 'x')] }, async (ctx) => {
    const put = (container: unknown) =>
      ctx.app.request(`/servers/${ctx.serverId}/terminal`, {
        method: 'PUT',
        headers: { ...ctx.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ container }),
      })
    const invalid = await put('yes')
    assertEquals(invalid.status, 400)
    await invalid.body?.cancel()

    const off = await put(false)
    assertEquals(off.status, 200)
    assertEquals(await off.json(), { ok: true, container: false, ended: 1 })
    assertEquals(ctx.killed, [{ all: true, reason: 'switch-off' }])
    const [row] = await ctx.db
      .select({ options: server.options })
      .from(server)
      .where(eq(server.id, ctx.serverId))
    assertEquals((row!.options as { terminal: { container: boolean } }).terminal.container, false)

    const on = await put(true)
    assertEquals(await on.json(), { ok: true, container: true, ended: 0 })
    assertEquals(ctx.killed.length, 1)
    assertEquals(await auditActions(ctx), [
      'server.terminal_settings.update',
      'server.terminal_settings.update',
    ])
  })
})
