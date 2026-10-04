/**
 * Org-level principal name defaults: request parsing, the options patch, and
 * the response shape for `GET/PUT /organizations/:id/principal-defaults`.
 *
 * Keys live on `organization.options`: `principalNameScheme` (the default
 * scheme), `principalNameSchemeLocked` (the policy lock) and the legacy
 * boolean `randomizedPrincipalUsernames`, which stays readable as a fallback
 * and is retired whenever the new scheme key is written.
 */

import {
  isPrincipalNameScheme,
  type PrincipalNameScheme,
  resolveOrgPrincipalNameScheme,
} from '../../lib/principal-name-scheme.ts'
import {
  type OrganizationOptions,
  resolvePrincipalNamePolicy,
  resolveRandomizedPrincipalUsernames,
} from './organization-options.ts'

export type PrincipalDefaultsPatch = {
  /** `undefined` leaves the scheme alone; `null` clears it to the platform default. */
  nameScheme?: PrincipalNameScheme | null
  schemeLocked?: boolean
}

type ParseResult = { ok: true; patch: PrincipalDefaultsPatch } | { ok: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSchemeField(body: Record<string, unknown>): PrincipalDefaultsPatch | null {
  if ('nameScheme' in body) {
    const value = body.nameScheme
    if (value === null || isPrincipalNameScheme(value)) return { nameScheme: value }
    return null
  }
  // Legacy shape: true = partial, false = plain, null = platform default.
  if ('randomizedUsernames' in body) {
    const value = body.randomizedUsernames
    if (value === null) return { nameScheme: null }
    if (typeof value === 'boolean') return { nameScheme: value ? 'partial' : 'plain' }
    return null
  }
  return {}
}

/** Parse a PUT body; at least one recognised field, each of the right type. */
export function parsePrincipalDefaultsPatch(body: unknown): ParseResult {
  if (!isRecord(body)) return { ok: false }
  const patch = parseSchemeField(body)
  if (patch === null) return { ok: false }
  if ('schemeLocked' in body) {
    if (typeof body.schemeLocked !== 'boolean') return { ok: false }
    patch.schemeLocked = body.schemeLocked
  }
  if (patch.nameScheme === undefined && patch.schemeLocked === undefined) return { ok: false }
  return { ok: true, patch }
}

/** Option keys to delete and keys to set for a patch (applied atomically in SQL). */
export function principalDefaultsOptionChanges(patch: PrincipalDefaultsPatch): {
  remove: string[]
  set: Record<string, unknown>
} {
  const remove: string[] = []
  const set: Record<string, unknown> = {}
  if (patch.nameScheme !== undefined) {
    remove.push('randomizedPrincipalUsernames')
    if (patch.nameScheme === null) remove.push('principalNameScheme')
    else set.principalNameScheme = patch.nameScheme
  }
  if (patch.schemeLocked === true) set.principalNameSchemeLocked = true
  if (patch.schemeLocked === false) remove.push('principalNameSchemeLocked')
  return { remove, set }
}

/** Response body shared by GET and PUT (legacy boolean fields kept for old clients). */
export function principalDefaultsResponse(options: OrganizationOptions) {
  const policy = resolvePrincipalNamePolicy(options)
  return {
    nameScheme: options.principalNameScheme ?? null,
    effectiveNameScheme: resolveOrgPrincipalNameScheme(options),
    schemeLocked: policy.locked,
    randomizedUsernames: options.randomizedPrincipalUsernames ?? null,
    effectiveRandomizedUsernames: resolveRandomizedPrincipalUsernames(options),
  }
}
