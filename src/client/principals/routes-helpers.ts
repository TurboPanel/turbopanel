/**
 * Pure helpers for project principal + resource-limits routes
 * (extracted for host-free coverage).
 */

import {
  assertSafePrincipalUsername,
  isReservedPrincipalUsername,
} from '../../lib/naming.ts'
import {
  isPrincipalAccessLevel,
  shellForAccessLevel,
} from '../../lib/principal-access.ts'
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
  /** Login actually created on the host (short name + optional random suffix). */
  appliedUsername: string
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
      appliedUsername: inserted.appliedUsername,
      uid: inserted.uid,
      gid: inserted.gid,
      serviceIds,
    }
  }
  return {
    ok: true as const,
    id: inserted.id,
    appliedUsername: inserted.appliedUsername,
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

/** A PATCH must change something: stewards, entitlements, or access. */
export function patchTouchesPrincipal(body: Record<string, unknown>): boolean {
  return 'serviceIds' in body || 'entitlements' in body || 'access' in body
}

/**
 * Parse an `entitlements` field into rows.
 *
 * `null` means invalid — rejected rather than dropped, because silently
 * discarding a malformed grant list would **revoke** every entitlement the
 * principal should hold. Absent means "leave them alone", which is why the
 * caller distinguishes `undefined` from `[]`.
 */
export function parseEntitlementsField(
  body: Record<string, unknown>,
  supported: { runtimes: readonly string[]; series: readonly string[] },
): { runtime: string; series: string; grantedBy: 'operator' }[] | null | undefined {
  if (!('entitlements' in body)) return undefined
  const raw = body.entitlements
  if (!Array.isArray(raw)) return null
  const out: { runtime: string; series: string; grantedBy: 'operator' }[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null
    const record = entry as Record<string, unknown>
    const runtime = record.runtime
    const series = record.series
    if (typeof runtime !== 'string' || typeof series !== 'string') return null
    if (!supported.runtimes.includes(runtime)) return null
    if (!supported.series.includes(series)) return null
    const key = `${runtime}@${series}`
    if (seen.has(key)) continue
    seen.add(key)
    // Anything set through the API is an operator grant by definition; a
    // deploy-derived one is inserted by deploy-prepare, not by a client.
    out.push({ runtime, series, grantedBy: 'operator' })
  }
  return out
}

/**
 * Parse an `access` field into the shell that encodes it.
 *
 * Same three-way result as {@link parseEntitlementsField} and for the same
 * reason: absent means "leave it alone", a value means "set it", and `null`
 * means invalid — rejected rather than dropped, because silently discarding a
 * malformed access level would leave the operator believing they had suspended
 * an account that is still reachable.
 *
 * The operator sets a *level*; the shell is how it is stored. Accepting a raw
 * shell path here instead would put a filesystem path in a security-decision
 * field, which is what the Phase 0 allowlist already had to defend against.
 */
export function parseAccessField(
  body: Record<string, unknown>,
): string | null | undefined {
  if (!('access' in body)) return undefined
  const raw = body.access
  if (!isPrincipalAccessLevel(raw)) return null
  return shellForAccessLevel(raw)
}

export const MIN_PRINCIPAL_PASSWORD_LENGTH = 8
export const MAX_PRINCIPAL_PASSWORD_LENGTH = 128

/**
 * Parse the optional `password` on a set-password request.
 *
 * Absent means "generate one for me" — the show-once flow, and the one most
 * operators should take. A supplied value must be printable and within
 * bounds; control characters are rejected because they cannot be typed back
 * at an `ssh` prompt, so accepting one would store a password that can never
 * authenticate.
 */
export function parsePrincipalPasswordField(
  body: Record<string, unknown>,
): { password?: string } | null {
  if (!('password' in body) || body.password === undefined) return {}
  const raw = body.password
  if (typeof raw !== 'string') return null
  if (
    raw.length < MIN_PRINCIPAL_PASSWORD_LENGTH ||
    raw.length > MAX_PRINCIPAL_PASSWORD_LENGTH
  ) {
    return null
  }
  if (/\p{Cc}/u.test(raw)) return null
  return { password: raw }
}

const GENERATED_PASSWORD_LENGTH = 20
const GENERATED_PASSWORD_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Random show-once password: 20 base62 chars (~119 bits), unbiased via
 * rejection sampling, and typable anywhere — no shell-hostile symbols to
 * mis-copy over a phone call.
 */
export function generatePrincipalPassword(): string {
  const limit = 256 - (256 % GENERATED_PASSWORD_ALPHABET.length)
  let out = ''
  while (out.length < GENERATED_PASSWORD_LENGTH) {
    const bytes = new Uint8Array(GENERATED_PASSWORD_LENGTH * 2)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= limit || out.length >= GENERATED_PASSWORD_LENGTH) continue
      out += GENERATED_PASSWORD_ALPHABET[byte % GENERATED_PASSWORD_ALPHABET.length]
    }
  }
  return out
}
