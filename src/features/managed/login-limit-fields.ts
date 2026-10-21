/**
 * Request fields for a login's source limit and connection cap, shared by
 * POST and PATCH `/managed/users`. Plain-words 400s; the daemon check keeps a
 * limit from being saved on a server that could not enforce it.
 */

import type { Context } from 'hono'
import type { ManagedContext } from './managed-context.ts'
import type { ManagedRowOptions } from './options.ts'
import { type LoginPatchCurrent, type LoginPatchResult, planLoginPatch } from './login-patch.ts'
import { parseManagedLoginPatchFields } from './routes-helpers.ts'
import type { Db } from '../../db/connection.ts'
import {
  type DaemonOwnerSupport,
  refuseReadWriteOnOldDaemon,
  type ReadWriteGrantState,
} from './owner-role.ts'
import {
  MANAGED_DATA_ONLY_READWRITE_FEATURE,
  MANAGED_DATABASE_CONVERT_FEATURE,
  MANAGED_DATABASE_OWNER_FEATURE,
  MANAGED_LOGIN_LIMITS_FEATURE,
  MANAGED_OWNER_ROLE_FEATURE,
} from '../../lib/version-wire.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import {
  type LoginSourcesError,
  loginSourceServerIds,
  parseLoginAllowedSources,
  parseLoginMaxConnections,
} from './login-sources.ts'
import { findOrganizationServerIds } from './login-sources-load.ts'
import {
  isStraightThroughValue,
  refuseStraightThrough,
  STRAIGHT_THROUGH_INVALID_MESSAGE,
} from './login-straight-through.ts'

/** Present keys only. `null` clears: `allowedSources: null` means anywhere. */
export type LoginLimitFields = {
  allowedSources?: string[] | null
  maxConnections?: number | null
  /** PostgreSQL only; `null` goes back to the default. */
  straightThrough?: boolean | null
}

const isError = (value: unknown): value is LoginSourcesError =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'error' in value

export async function parseLoginLimitFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>
): Promise<LoginLimitFields | Response> {
  const fields: LoginLimitFields = {}
  if (body.allowedSources !== undefined) {
    const parsed = parseLoginAllowedSources(body.allowedSources)
    if (isError(parsed)) return c.json(parsed, 400)
    if (parsed !== null) {
      const ids = loginSourceServerIds(parsed)
      const known = await findOrganizationServerIds(db, organizationId, ids)
      const unknown = ids.find((id) => !known.has(id))
      if (unknown !== undefined) {
        return c.json(
          {
            error: 'managed_login_source_server_unknown',
            message: `'server:${unknown}' is not one of this organization's servers.`,
          },
          400
        )
      }
    }
    fields.allowedSources = parsed
  }
  if (body.maxConnections !== undefined) {
    const parsed = parseLoginMaxConnections(body.maxConnections)
    if (isError(parsed)) return c.json(parsed, 400)
    fields.maxConnections = parsed
  }
  if (body.straightThrough !== undefined) {
    if (!isStraightThroughValue(body.straightThrough)) {
      return c.json({ error: 'Invalid request', message: STRAIGHT_THROUGH_INVALID_MESSAGE }, 400)
    }
    fields.straightThrough = body.straightThrough
  }
  return fields
}

/** True when the request asks for a limit (not just clearing one). */
export function loginLimitsRequested(fields: LoginLimitFields): boolean {
  return (
    (fields.allowedSources !== undefined && fields.allowedSources !== null) ||
    (fields.maxConnections !== undefined && fields.maxConnections !== null)
  )
}

/** What the new limits set on a new login (nothing for anywhere / no cap). */
export function loginLimitSettings(fields: LoginLimitFields): {
  allowedSources?: string[]
  maxConnections?: number
  straightThrough?: boolean
} {
  return {
    ...(fields.allowedSources ? { allowedSources: fields.allowedSources } : {}),
    ...(fields.maxConnections ? { maxConnections: fields.maxConnections } : {}),
    // Only an explicit choice is stored; absent or `null` keeps the default.
    ...(typeof fields.straightThrough === 'boolean'
      ? { straightThrough: fields.straightThrough }
      : {}),
  }
}

/** 400 when a new login asks to connect straight through where that cannot apply; `null` when fine. */
export function refuseStraightThroughOnCreate(
  c: Context,
  engine: string,
  fields: LoginLimitFields
): Response | null {
  const refusal = refuseStraightThrough({
    engine,
    role: 'user',
    allowedSources: fields.allowedSources ?? undefined,
    straightThrough: fields.straightThrough ?? undefined,
  })
  return refusal ? c.json({ error: refusal.error, message: refusal.message }, refusal.status) : null
}

/** Parse the limit fields and refuse (400/409) what a new login could not have or this server could not enforce. */
export async function parseGatedLoginLimits(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  serverId: string,
  engine: string
): Promise<LoginLimitFields | Response> {
  const fields = await parseLoginLimitFields(c, db, organizationId, body)
  if (fields instanceof Response) return fields
  // Before the daemon check, so the conflict reads the same on every server.
  const straightRefused = refuseStraightThroughOnCreate(c, engine, fields)
  if (straightRefused) return straightRefused
  return (await refuseLimitsIfUnsupported(c, db, fields, serverId)) ?? fields
}

/** Refuses (409) a requested limit when the server's daemon cannot enforce it; `null` when fine. */
export async function refuseLimitsIfUnsupported(
  c: Context,
  db: Db,
  fields: LoginLimitFields,
  serverId: string
): Promise<Response | null> {
  if (!loginLimitsRequested(fields)) return null
  return refuseIfDaemonCannotLimitLogins(c, db, serverId)
}

/** 409 when the server's daemon is too old to enforce limits; `null` when fine. */
export async function refuseIfDaemonCannotLimitLogins(
  c: Context,
  db: Db,
  serverId: string
): Promise<Response | null> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  if ((state?.projection?.features ?? []).includes(MANAGED_LOGIN_LIMITS_FEATURE)) return null
  return c.json(
    {
      error: 'managed_login_limits_need_daemon_update',
      message:
        "This server's TurboPanel daemon is too old to limit where a login connects from or how many connections it holds. Update the server, then try again.",
    },
    409
  )
}

/** Whether the server's daemon honours owner roles and the Database admin login. */
export async function daemonHonoursOwnerRole(db: Db, serverId: string): Promise<boolean> {
  return (await daemonOwnerSupport(db, serverId)).ownerRole
}

/** Whether the server's daemon can move an existing database onto its owner role. */
export async function daemonCanConvertDatabase(db: Db, serverId: string): Promise<boolean> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return (state?.projection?.features ?? []).includes(MANAGED_DATABASE_CONVERT_FEATURE)
}

/** Which of the owner-role features the server's daemon lists. */
export async function daemonOwnerSupport(db: Db, serverId: string): Promise<DaemonOwnerSupport> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  const features = state?.projection?.features ?? []
  return {
    ownerRole: features.includes(MANAGED_OWNER_ROLE_FEATURE),
    databaseOwner: features.includes(MANAGED_DATABASE_OWNER_FEATURE),
  }
}

/** 409 for a panel-managed MySQL or MariaDB read/write login (or a new database on one) when the daemon is too old; `null` when fine. */
export async function refuseReadWriteIfDaemonTooOld(
  c: Context,
  db: Db,
  engine: string,
  after: ReadWriteGrantState,
  before: ReadWriteGrantState | null,
  serverId: string
): Promise<Response | null> {
  if (engine !== 'mysql' && engine !== 'mariadb') return null
  const state = await getServerDaemonStateByServerId(db, serverId)
  const supported = (state?.projection?.features ?? []).includes(
    MANAGED_DATA_ONLY_READWRITE_FEATURE
  )
  const refused = refuseReadWriteOnOldDaemon(engine, after, before, supported)
  return refused ? c.json({ error: refused.error, message: refused.message }, refused.status) : null
}

/** The daemon check a login create needs: the MySQL and MariaDB read/write level. */
export async function refuseLoginCreateIfDaemonCannot(
  c: Context,
  db: Db,
  change: { engine: string; privileges: unknown; grantMode: string },
  serverId: string
): Promise<Response | null> {
  const privileges = Array.isArray(change.privileges) ? (change.privileges as string[]) : []
  return refuseReadWriteIfDaemonTooOld(
    c,
    db,
    change.engine,
    { privileges, grantMode: change.grantMode },
    null,
    serverId
  )
}

/** The daemon checks a login PATCH needs: limits it can enforce and the MySQL and MariaDB read/write level. */
export async function refuseLoginPatchIfDaemonCannot(
  c: Context,
  db: Db,
  change: {
    limits: LoginLimitFields
    engine: string
    readWrite: { after: ReadWriteGrantState; before: ReadWriteGrantState }
  },
  serverId: string
): Promise<Response | null> {
  return (
    (await refuseLimitsIfUnsupported(c, db, change.limits, serverId)) ??
    (await refuseReadWriteIfDaemonTooOld(
      c,
      db,
      change.engine,
      change.readWrite.after,
      change.readWrite.before,
      serverId
    ))
  )
}

/** PATCH body: the ordinary fields plus the limit fields, as one planning input. */
export async function parseLoginPatchRequest(
  c: Context,
  db: Db,
  ctx: ManagedContext,
  body: Record<string, unknown>,
  options: ManagedRowOptions,
  target: LoginPatchCurrent
): Promise<{ dryRun: boolean; limits: LoginLimitFields; plan: LoginPatchResult } | Response> {
  const fields = parseManagedLoginPatchFields(c, ctx, body, options)
  if (fields instanceof Response) return fields
  const limits = await parseLoginLimitFields(c, db, ctx.organizationId, body)
  if (limits instanceof Response) return limits
  const { dryRun, ...input } = { ...fields, ...limits }
  const plan = planLoginPatch(ctx.spec.engine, target, input)
  if (!plan.ok) {
    return c.json({ error: plan.error, message: plan.message }, plan.status)
  }
  return { dryRun, limits, plan }
}
