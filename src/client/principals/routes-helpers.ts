/**
 * Pure helpers for project principal + resource-limits routes
 * (extracted for host-free coverage).
 */

import {
  assertSafePrincipalUsername,
  isReservedPrincipalUsername,
} from '../../lib/naming.ts'
import {
  parsePrincipalOptionsInput,
  resolvePrincipalIdOverride,
  type PrincipalOptionsPersisted,
} from '../../lib/principal-options.ts'
import { parseResourceLimits } from '../../lib/resource-limits.ts'

export type PrincipalRouteValidationError = {
  ok: false
  error: string
  status: 400
}

/**
 * Accept top-level `uid`/`gid` as a shorthand for `options.uid`/`options.gid`.
 * Non-object `options` are left as-is so strict parse rejects them.
 */
export function mergeTopLevelPrincipalIdsIntoOptions(
  body: Record<string, unknown>,
): unknown {
  if (body.uid === undefined && body.gid === undefined) {
    return body.options
  }
  if (body.options === undefined || body.options === null) {
    return { uid: body.uid, gid: body.gid }
  }
  if (typeof body.options === 'object' && !Array.isArray(body.options)) {
    return {
      ...(body.options as Record<string, unknown>),
      ...(body.uid !== undefined ? { uid: body.uid } : {}),
      ...(body.gid !== undefined ? { gid: body.gid } : {}),
    }
  }
  return body.options
}

export function parsePrincipalUsernameValue(
  usernameRaw: string,
): { ok: true; username: string } | PrincipalRouteValidationError {
  const username = usernameRaw.trim()
  try {
    assertSafePrincipalUsername(username)
  } catch {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (isReservedPrincipalUsername(username)) {
    return { ok: false, error: 'username_reserved', status: 400 }
  }
  return { ok: true, username }
}

export type ParsedCreatePrincipalOptions =
  | {
    ok: true
    options: PrincipalOptionsPersisted
    override: { uid: number; gid: number } | null
  }
  | PrincipalRouteValidationError

export function parseCreatePrincipalOptions(
  body: Record<string, unknown>,
): ParsedCreatePrincipalOptions {
  const parsedOptions = parsePrincipalOptionsInput(
    mergeTopLevelPrincipalIdsIntoOptions(body),
  )
  if (!parsedOptions.ok) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  return {
    ok: true,
    options: parsedOptions.value,
    override: resolvePrincipalIdOverride(parsedOptions.value),
  }
}

export type InsertedProjectPrincipal = {
  id: string
  uid?: number
  gid?: number
}

export function projectPrincipalCreateResponse(
  inserted: InsertedProjectPrincipal,
  serviceIds: string[],
) {
  if (inserted.uid !== undefined && inserted.gid !== undefined) {
    return {
      ok: true as const,
      id: inserted.id,
      uid: inserted.uid,
      gid: inserted.gid,
      serviceIds,
    }
  }
  return {
    ok: true as const,
    id: inserted.id,
    serviceIds,
  }
}

export function optionsRecordFromJsonb(options: unknown): Record<string, unknown> {
  if (options && typeof options === 'object') {
    return options as Record<string, unknown>
  }
  return {}
}

export function resourceLimitsFromOptions(options: unknown) {
  const record = optionsRecordFromJsonb(options)
  return parseResourceLimits(record.resourceLimits) ?? {}
}

export function patchRequiresServiceIds(body: Record<string, unknown>): boolean {
  return 'serviceIds' in body
}
