/**
 * Defensive parser for `principal.options` jsonb. Validates `shell` and
 * optional operator `uid`/`gid` overrides, and resolves the default shell
 * (`/usr/sbin/nologin`) for deploy materialization.
 * Create/request paths use {@link parsePrincipalOptionsInput} (strict).
 */

import {
  PRINCIPAL_RESERVED_UID_MAX,
  PRINCIPAL_RESERVED_UID_MIN,
  PRINCIPAL_UID_START,
} from './naming.ts'

export type PrincipalOptions = {
  shell?: string
  uid?: number
  gid?: number
}

/** Persisted create shape — `shell` is always present; ids optional. */
export type PrincipalOptionsPersisted = {
  shell: string
  uid?: number
  gid?: number
}

export const DEFAULT_PRINCIPAL_SHELL = '/usr/sbin/nologin'

const MAX_SHELL_PATH_LENGTH = 255
/** Absolute path: leading `/`, no whitespace/newline/NUL, conservative allowlist. */
const PRINCIPAL_SHELL_RE = /^\/[A-Za-z0-9._+/-]{0,254}$/

/**
 * Shells a principal may be given. A closed list, not a path shape check.
 *
 * `options.shell` reaches `useradd -s` / `usermod -s` on the host, so it is a
 * privilege decision, not a formatting one: a path-shaped value would let
 * anyone with `organization:manage` point a tenant account at any executable on
 * the box. That mattered less while every principal was `nologin`; it stops
 * being theoretical the moment principals get interactive access.
 *
 * Keep in step with the daemon's own list — it re-validates rather than
 * trusting the wire, because `ensurePrincipalUser` will happily `usermod -s` an
 * adopted account to whatever it is handed.
 */
export const ALLOWED_PRINCIPAL_SHELLS: readonly string[] = [
  '/usr/sbin/nologin',
  '/sbin/nologin',
  '/bin/false',
  '/bin/sh',
  '/bin/bash',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidPrincipalShell(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SHELL_PATH_LENGTH) return false
  if (/\s/.test(value) || value.includes('\0') || value.includes('\n')) return false
  // Match daemon `assertSafeAbsolutePath`: reject parent-directory segments.
  if (value.split('/').includes('..')) return false
  if (!PRINCIPAL_SHELL_RE.test(value)) return false
  // The shape checks above stay as defence in depth; membership is the gate.
  return ALLOWED_PRINCIPAL_SHELLS.includes(value)
}

/**
 * Operator override floor: integer ≥ {@link PRINCIPAL_UID_START}, outside the
 * reserved TurboPanel service-account band.
 */
export function isValidPrincipalIdOverride(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  if (value < PRINCIPAL_UID_START) return false
  if (value >= PRINCIPAL_RESERVED_UID_MIN && value <= PRINCIPAL_RESERVED_UID_MAX) {
    return false
  }
  return true
}

function readIdOverridePair(
  value: Record<string, unknown>,
): { uid: number; gid: number } | null {
  const hasUid = 'uid' in value && value.uid !== undefined
  const hasGid = 'gid' in value && value.gid !== undefined
  if (!hasUid || !hasGid) return null
  if (!isValidPrincipalIdOverride(value.uid) || !isValidPrincipalIdOverride(value.gid)) {
    return null
  }
  return { uid: value.uid, gid: value.gid }
}

/**
 * Strict shell parse for create input.
 * Omitted/`undefined` → default; malformed → fail.
 */
function parsePrincipalShellInput(
  value: Record<string, unknown>,
): { ok: true; shell: string } | { ok: false } {
  if (!('shell' in value) || value.shell === undefined) {
    return { ok: true, shell: DEFAULT_PRINCIPAL_SHELL }
  }
  if (typeof value.shell !== 'string') return { ok: false }
  // Reject newline/NUL before trim so they cannot be silently stripped.
  if (value.shell.includes('\0') || value.shell.includes('\n')) return { ok: false }
  const trimmed = value.shell.trim()
  if (!isValidPrincipalShell(trimmed)) return { ok: false }
  return { ok: true, shell: trimmed }
}

/**
 * Strict uid/gid pair for create input.
 * Both omitted → host allocates (`null`); one-of-two or invalid → fail.
 */
function parsePrincipalIdOverrideInput(
  value: Record<string, unknown>,
): { ok: true; override: { uid: number; gid: number } | null } | { ok: false } {
  const hasUid = 'uid' in value && value.uid !== undefined
  const hasGid = 'gid' in value && value.gid !== undefined
  if (hasUid !== hasGid) return { ok: false }
  if (!hasUid) return { ok: true, override: null }
  if (!isValidPrincipalIdOverride(value.uid) || !isValidPrincipalIdOverride(value.gid)) {
    return { ok: false }
  }
  return { ok: true, override: { uid: value.uid, gid: value.gid } }
}

/** Parse principal.options jsonb (missing/invalid keys → omitted). */
export function parsePrincipalOptions(value: unknown): PrincipalOptions {
  if (!isRecord(value)) return {}
  const options: PrincipalOptions = {}
  if (typeof value.shell === 'string') {
    // Reject newline/NUL before trim so they cannot be silently stripped.
    if (!value.shell.includes('\0') && !value.shell.includes('\n')) {
      const trimmed = value.shell.trim()
      if (isValidPrincipalShell(trimmed)) options.shell = trimmed
    }
  }
  // Lenient: accept uid/gid only when both are present and valid; else omit both.
  const override = readIdOverridePair(value)
  if (override) {
    options.uid = override.uid
    options.gid = override.gid
  }
  return options
}

/**
 * Strict request parser for principal create `options`.
 *
 * - `undefined` / `null` / `{}` / omitted `shell` → default shell persisted
 * - non-object (when provided) or malformed `shell` → `{ ok: false }`
 * - omitted uid/gid → host allocates (ids omitted)
 * - one-of-two or invalid ids → `{ ok: false }`
 * - both valid → persisted override
 */
export function parsePrincipalOptionsInput(
  value: unknown,
): { ok: true; value: PrincipalOptionsPersisted } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value: { shell: DEFAULT_PRINCIPAL_SHELL } }
  }
  if (!isRecord(value)) return { ok: false }

  const shellResult = parsePrincipalShellInput(value)
  if (!shellResult.ok) return { ok: false }

  const idsResult = parsePrincipalIdOverrideInput(value)
  if (!idsResult.ok) return { ok: false }

  if (idsResult.override) {
    return {
      ok: true,
      value: {
        shell: shellResult.shell,
        uid: idsResult.override.uid,
        gid: idsResult.override.gid,
      },
    }
  }
  return { ok: true, value: { shell: shellResult.shell } }
}

/** Default shell when absent/invalid. */
export function resolvePrincipalShell(
  options: PrincipalOptions | null | undefined,
): string {
  return options?.shell ?? DEFAULT_PRINCIPAL_SHELL
}

/** Operator uid/gid override for deploy wire material, or null when host allocates. */
export function resolvePrincipalIdOverride(
  options: PrincipalOptions | null | undefined,
): { uid: number; gid: number } | null {
  if (
    options?.uid === undefined ||
    options.gid === undefined ||
    !isValidPrincipalIdOverride(options.uid) ||
    !isValidPrincipalIdOverride(options.gid)
  ) {
    return null
  }
  return { uid: options.uid, gid: options.gid }
}
