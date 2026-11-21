/**
 * Container terminals on a server (feature `terminal-container-v1`).
 *
 * - `POST   /servers/:id/terminal-sessions`      open one (answer: sid, ticket, key)
 * - `GET    /servers/:id/terminal-sessions`      the sessions the caller may see
 * - `DELETE /servers/:id/terminal-sessions/:sid` end one
 * - `PUT    /servers/:id/terminal`               the server's switch, `{ container }`
 *
 * The gate is `./policy.ts`; the server's own switch is checked first and
 * always wins. The switch changes only here, never through the generic server
 * patch, because turning it off also ends every open session on the server.
 */
import { eq, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { isUuid } from '../access/routes-helpers.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { can } from '../authz/evaluator.ts'
import { resolveOrgRequest } from '../org-request.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { getDaemonCellRegistry } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import { isShellSid } from '../../contracts/shell-relay.ts'
import { TERMINAL_CONTAINER_FEATURE } from '../../lib/version-wire.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import {
  evaluateTerminalGate,
  isValidLoginUser,
  isValidTerminalSize,
  TERMINAL_MAX_DIM,
} from '../../features/terminal/policy.ts'
import {
  endTerminalSessions,
  listTerminalSessions,
  loadServerTerminalFacts,
  loadTerminalContainerFacts,
  openTerminalSession,
} from './sessions.ts'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export function registerTerminalRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for terminal routes')
  }
  // The session gate is the one `registerServerRoutes` puts on `/servers/*`;
  // this registrar must run after it (see `src/client/routes.ts`).

  router.post('/servers/:id/terminal-sessions', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope
    const serverId = c.req.param('id')
    if (!isUuid(serverId) || !(await verifyServerInOrg(db, serverId, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }
    if (!opts.shellTicketSecrets) {
      return c.json({ error: 'Terminals are not available', code: 'terminal_unavailable' }, 503)
    }
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Terminals are not available' }, 503)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const kind = body.kind ?? 'container'
    if (kind !== 'container') {
      return c.json({ error: 'Only container terminals are available', code: 'bad_kind' }, 400)
    }
    const containerRowId = body.containerId
    if (typeof containerRowId !== 'string' || !isUuid(containerRowId)) {
      return c.json({ error: 'containerId must be a container id' }, 400)
    }
    const loginUser = body.user ?? ''
    if (loginUser !== '' && !isValidLoginUser(loginUser)) {
      return c.json({ error: 'user is not a valid login name' }, 400)
    }
    const cols = body.cols ?? DEFAULT_COLS
    const rows = body.rows ?? DEFAULT_ROWS
    if (!isValidTerminalSize(cols) || !isValidTerminalSize(rows)) {
      return c.json({ error: `cols and rows must be 1 to ${TERMINAL_MAX_DIM}` }, 400)
    }

    const serverFacts = await loadServerTerminalFacts(db, serverId)
    if (serverFacts?.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }
    const [holdsPermission, containerFacts, presence] = await Promise.all([
      can(db, session.userId, 'terminal:container', 'server', serverId),
      loadTerminalContainerFacts(db, { serverId, organizationId, containerRowId }),
      resolveFleetPresence(db, registry, [serverId]),
    ])
    const verdict = evaluateTerminalGate({
      switchOn: serverFacts.switchOn,
      holdsPermission,
      containerOwned: containerFacts.owned,
      containerRunning: containerFacts.running,
      daemonHasFeature:
        presence.get(serverId)?.features?.includes(TERMINAL_CONTAINER_FEATURE) === true,
    })
    if (!verdict.ok) return c.json({ error: verdict.code, code: verdict.code }, verdict.status)

    const opened = await openTerminalSession({
      db,
      registry,
      ticketKeyring: opts.shellTicketSecrets,
      serverId,
      organizationId,
      userId: session.userId,
      userEmail: session.email,
      authSessionId: session.sessionId,
      containerRowId,
      dockerContainerId: containerFacts.dockerId,
      loginUser,
      cols,
      rows,
    })
    if (!opened.ok) return c.json({ error: opened.code, code: opened.code }, opened.status)
    c.header('Cache-Control', 'no-store')
    return c.json(
      {
        ok: true as const,
        sid: opened.sid,
        wsUrl: opened.wsPath,
        ticket: opened.ticket,
        key: opened.key,
        protocol: opened.protocol,
        idleSec: opened.idleSec,
        maxSec: opened.maxSec,
        expiresAt: new Date(opened.expiresAtMs).toISOString(),
      },
      201
    )
  })

  router.get('/servers/:id/terminal-sessions', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope
    const serverId = c.req.param('id')
    if (!isUuid(serverId) || !(await verifyServerInOrg(db, serverId, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: true as const, sessions: [] })
    const manager = await can(db, session.userId, 'organization:manage', 'server', serverId)
    const sessions = (await listTerminalSessions(registry, serverId)).filter(
      (info) => manager || info.userId === session.userId
    )
    c.header('Cache-Control', 'no-store')
    return c.json({ ok: true as const, sessions })
  })

  router.delete('/servers/:id/terminal-sessions/:sid', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope
    const serverId = c.req.param('id')
    const sid = c.req.param('sid')
    if (!isUuid(serverId) || !isShellSid(sid)) return c.json({ error: 'Not found' }, 404)
    if (!(await verifyServerInOrg(db, serverId, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Not found' }, 404)
    const known = (await listTerminalSessions(registry, serverId)).find((info) => info.sid === sid)
    if (!known) return c.json({ error: 'Not found' }, 404)
    // Your own session, or any session when you manage the server.
    if (
      known.userId !== session.userId &&
      !(await can(db, session.userId, 'organization:manage', 'server', serverId))
    ) {
      return c.json({ error: 'Not found' }, 404)
    }
    const killed = await endTerminalSessions(registry, serverId, { sid, reason: 'revoked' })
    return c.json({ ok: true as const, ended: killed > 0 })
  })

  router.put('/servers/:id/terminal', async (c) => {
    const scope = await resolveOrgRequest(c)
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope
    const serverId = c.req.param('id')
    if (!isUuid(serverId) || !(await verifyServerInOrg(db, serverId, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }
    const denied = await assertCanManageOr403(c, 'server', serverId)
    if (denied) return denied
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    if (typeof body.container !== 'boolean') {
      return c.json({ error: 'container must be true or false' }, 400)
    }
    const next = body.container

    const before = (await loadServerTerminalFacts(db, serverId))?.switchOn ?? false
    // One atomic merge: other keys under `options` are never rewritten from a stale read.
    await db
      .update(server)
      .set({
        options: sql`coalesce(${server.options}, '{}'::jsonb) || jsonb_build_object('terminal', coalesce(${server.options}->'terminal', '{}'::jsonb) || jsonb_build_object('container', ${next}::boolean))`,
      })
      .where(eq(server.id, serverId))
    await recordAudit(db, {
      organizationId,
      actorUserId: session.userId,
      actorEmail: session.email,
      action: 'server.terminal_settings.update',
      targetType: 'server',
      targetId: serverId,
      context: { serverId, setting: 'container', before, after: next },
    })

    let ended = 0
    if (!next) {
      const registry = getDaemonCellRegistry(c)
      // Also when it was already off: a session left over from before is ended too.
      if (registry)
        ended = await endTerminalSessions(registry, serverId, { all: true, reason: 'switch-off' })
    }
    return c.json({ ok: true as const, container: next, ended })
  })
}
