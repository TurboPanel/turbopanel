/**
 * Principal name schemes: how the SYSTEM name (the login on the host or the
 * database engine, `principal.applied_username`) is derived from the name a
 * person typed (`principal.username`, the display name TurboPanel shows).
 *
 * - `plain`   system name = typed name
 * - `partial` typed name + `_` + 11 random chars (the platform default)
 * - `random`  fully random system name, no trace of the typed name
 *
 * Pure and runtime-neutral (no DB, no Deno/Node APIs beyond `crypto`).
 */

import {
  isReservedPrincipalUsername,
  PRINCIPAL_APPLIED_SUFFIX_LENGTH,
  PRINCIPAL_APPLIED_SUFFIX_RANDOM_LENGTH,
  randomPrincipalUsernameSuffix,
} from './naming.ts'

export const PRINCIPAL_NAME_SCHEMES = ['plain', 'partial', 'random'] as const

export type PrincipalNameScheme = (typeof PRINCIPAL_NAME_SCHEMES)[number]

/** Scheme every organization starts with (and what the old `true` meant). */
export const DEFAULT_PRINCIPAL_NAME_SCHEME: PrincipalNameScheme = 'partial'

/** Stable error code: a create asked for a scheme the org policy forbids. */
export const PRINCIPAL_SCHEME_LOCKED_ERROR = 'principal_scheme_locked'
/** Stable error code: `nameScheme` was not one of the three schemes. */
export const INVALID_NAME_SCHEME_ERROR = 'invalid_name_scheme'

/** Length of a fully random system name (leading letter + 11 chars). */
export const RANDOM_SYSTEM_NAME_LENGTH = PRINCIPAL_APPLIED_SUFFIX_RANDOM_LENGTH + 1

const LEADING_LETTERS = 'abcdefghijklmnopqrstuvwxyz'

export function isPrincipalNameScheme(value: unknown): value is PrincipalNameScheme {
  return typeof value === 'string' && (PRINCIPAL_NAME_SCHEMES as readonly string[]).includes(value)
}

/**
 * Org default scheme. The new key wins; the legacy boolean
 * `randomizedPrincipalUsernames` is the fallback (true -> partial,
 * false -> plain); neither set means `partial`.
 */
export function resolveOrgPrincipalNameScheme(options: {
  principalNameScheme?: PrincipalNameScheme
  randomizedPrincipalUsernames?: boolean
}): PrincipalNameScheme {
  if (options.principalNameScheme) return options.principalNameScheme
  if (options.randomizedPrincipalUsernames === false) return 'plain'
  return DEFAULT_PRINCIPAL_NAME_SCHEME
}

export type PrincipalNamePolicy = {
  /** Effective org default scheme. */
  defaultScheme: PrincipalNameScheme
  /** When true every NEW principal must use `defaultScheme`. */
  locked: boolean
}

export type SchemeRequestResult =
  | { ok: true; scheme: PrincipalNameScheme }
  | {
      ok: false
      error: typeof PRINCIPAL_SCHEME_LOCKED_ERROR | typeof INVALID_NAME_SCHEME_ERROR
      status: 400 | 409
    }

/**
 * Pick the scheme for a create request. `requested` is the raw client value
 * (undefined = "use the default"). A lock rejects any different scheme; asking
 * for the locked scheme itself is fine.
 */
export function resolveRequestedNameScheme(
  policy: PrincipalNamePolicy,
  requested: unknown
): SchemeRequestResult {
  if (requested === undefined || requested === null) {
    return { ok: true, scheme: policy.defaultScheme }
  }
  if (!isPrincipalNameScheme(requested)) {
    return { ok: false, error: INVALID_NAME_SCHEME_ERROR, status: 400 }
  }
  if (policy.locked && requested !== policy.defaultScheme) {
    return { ok: false, error: PRINCIPAL_SCHEME_LOCKED_ERROR, status: 409 }
  }
  return { ok: true, scheme: requested }
}

/**
 * Longest typed name a scheme allows for a system whose login limit is
 * `maxLength`. Only `partial` spends room on a suffix.
 */
export function maxTypedNameLength(scheme: PrincipalNameScheme, maxLength: number): number {
  return scheme === 'partial' ? maxLength - PRINCIPAL_APPLIED_SUFFIX_LENGTH : maxLength
}

/**
 * A fully random system name: one lowercase letter then 11 lowercase
 * alphanumerics (`u7k2m9x4qpz1`). No `_`, `-` or `.`, so it satisfies Linux,
 * Postgres and MySQL identifier rules. Never a reserved name or `tp`-prefixed
 * (platform accounts); re-rolled until it is neither.
 */
export function randomPrincipalSystemName(): string {
  for (;;) {
    const lead = LEADING_LETTERS[randomIndex(LEADING_LETTERS.length)]
    const candidate = `${lead}${randomPrincipalUsernameSuffix().slice(1)}`
    if (!isReservedPrincipalUsername(candidate)) return candidate
  }
}

function randomIndex(size: number): number {
  const limit = 256 - (256 % size)
  const byte = new Uint8Array(1)
  for (;;) {
    crypto.getRandomValues(byte)
    if (byte[0] < limit) return byte[0] % size
  }
}

export type SystemNameCandidates = {
  scheme: PrincipalNameScheme
  /** The name the person typed. */
  typed: string
  /** The target system's login length limit (Linux 28, engine identifier maxLength). */
  maxLength: number
}

/**
 * One system-name candidate for a scheme. `plain` is deterministic; the
 * others draw fresh randomness, so callers retry (probe for collisions) by
 * calling again. Throws `TypeError` when `partial` cannot fit the typed name.
 */
export function deriveSystemNameCandidate(input: SystemNameCandidates): string {
  if (input.scheme === 'plain') return input.typed
  if (input.scheme === 'random') return randomPrincipalSystemName()
  if (input.typed.length > maxTypedNameLength('partial', input.maxLength)) {
    throw new TypeError('typed name too long for a partial system name')
  }
  return `${input.typed}${randomPrincipalUsernameSuffix()}`
}

/**
 * Scheme of a stored principal. Rows created after this feature carry
 * `options.nameScheme`; older rows are derived from their names: system name
 * equal to the typed name was `plain`, anything else was `partial`.
 */
export function principalNameSchemeOf(row: {
  options?: unknown
  username: string
  appliedUsername: string
}): PrincipalNameScheme {
  const options = row.options
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    const stored = (options as Record<string, unknown>).nameScheme
    if (isPrincipalNameScheme(stored)) return stored
  }
  return row.appliedUsername === row.username ? 'plain' : 'partial'
}
