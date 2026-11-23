/**
 * Request fields for a login's source limit and connection cap, shared by
 * POST and PATCH `/managed/users`. Plain-words 400s.
 */

import type { Context } from 'hono'
import type { ManagedContext } from './managed-context.ts'
import type { ManagedRowOptions } from './options.ts'
import { type LoginPatchCurrent, type LoginPatchResult, planLoginPatch } from './login-patch.ts'
import { parseManagedLoginPatchFields } from './routes-helpers.ts'
import type { Db } from '../../db/connection.ts'
import { loadAllDatabasesRefusal } from './all-databases.ts'
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

/** Parse the limit fields and refuse (400) what a new login could not have. */
export async function parseGatedLoginLimits(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  engine: string
): Promise<LoginLimitFields | Response> {
  const fields = await parseLoginLimitFields(c, db, organizationId, body)
  if (fields instanceof Response) return fields
  return refuseStraightThroughOnCreate(c, engine, fields) ?? fields
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
  if (fields.allDatabases === true) {
    const refusal = await loadAllDatabasesRefusal(db, ctx.organizationId, options.settings)
    if (refusal) {
      return c.json({ error: 'managed_login_all_databases_not_allowed', message: refusal }, 400)
    }
  }
  const limits = await parseLoginLimitFields(c, db, ctx.organizationId, body)
  if (limits instanceof Response) return limits
  const { dryRun, ...input } = { ...fields, ...limits }
  const plan = planLoginPatch(ctx.spec.engine, target, input)
  if (!plan.ok) {
    return c.json({ error: plan.error, message: plan.message }, plan.status)
  }
  return { dryRun, limits, plan }
}
