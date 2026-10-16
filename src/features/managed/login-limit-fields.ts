/**
 * Request fields for a login's source limit and connection cap, shared by
 * POST and PATCH `/managed/users`. Plain-words 400s; the daemon check keeps a
 * limit from being saved on a server that could not enforce it.
 */

import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { MANAGED_LOGIN_LIMITS_FEATURE } from '../../lib/version-wire.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import {
  type LoginSourcesError,
  loginSourceServerIds,
  parseLoginAllowedSources,
  parseLoginMaxConnections,
} from './login-sources.ts'
import { findOrganizationServerIds } from './login-sources-load.ts'

/** Present keys only. `null` clears: `allowedSources: null` means anywhere. */
export type LoginLimitFields = {
  allowedSources?: string[] | null
  maxConnections?: number | null
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
  return fields
}

/** True when the request asks for a limit (not just clearing one). */
export function loginLimitsRequested(fields: LoginLimitFields): boolean {
  return (
    (fields.allowedSources !== undefined && fields.allowedSources !== null) ||
    (fields.maxConnections !== undefined && fields.maxConnections !== null)
  )
}

/** What the new limits add to a login's stored metadata (nothing for anywhere / no cap). */
export function loginLimitMetadata(fields: LoginLimitFields): Record<string, unknown> {
  return {
    ...(fields.allowedSources ? { allowedSources: fields.allowedSources } : {}),
    ...(fields.maxConnections ? { maxConnections: fields.maxConnections } : {}),
  }
}

/** Parse the limit fields and refuse (400/409) what this server could not enforce. */
export async function parseGatedLoginLimits(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  serverId: string
): Promise<LoginLimitFields | Response> {
  const fields = await parseLoginLimitFields(c, db, organizationId, body)
  if (fields instanceof Response) return fields
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
