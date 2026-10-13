/**
 * How a principal reaches its own account over SSH.
 *
 * **One field, not two.** The access level is not stored; it is *encoded* by
 * `options.shell`, which already exists, is already an allowlist, and is
 * already re-validated daemon-side before it reaches `useradd -s`. A separate
 * `options.access` would be a second source of truth that can disagree with the
 * first, and the disagreement would be invisible until someone could not log
 * in — the worst possible time to discover it.
 *
 * The mapping is total in both directions, which is what makes the encoding
 * safe rather than cute:
 *
 * | level   | shell                          | result                       |
 * | ------- | ------------------------------ | ---------------------------- |
 * | `none`  | `/bin/false`                   | no login; keys stay on file  |
 * | `sftp`  | `/usr/sbin/nologin`            | file transfer only           |
 * | `shell` | `/bin/bash`                    | interactive shell + transfer |
 *
 * `/sbin/nologin` and `/bin/sh` are read as aliases of `sftp` and `shell` so an
 * adopted account keeps working, but they are never written.
 *
 * `none` exists so an operator can suspend an account **without deleting its
 * keys** — "revoke access" and "throw away the credential" are different acts,
 * and a model that could only express the second would push operators into
 * deleting keys they meant to keep.
 *
 * Effective access is still gated on holding at least one key: see
 * {@link effectivePrincipalAccess}. An account with no keys cannot log in at any
 * level, because password authentication is off for these accounts and there is
 * nothing else to present.
 */

import { DEFAULT_PRINCIPAL_SHELL } from './principal-options.ts'

export const PRINCIPAL_ACCESS_LEVELS = ['none', 'sftp', 'shell'] as const

export type PrincipalAccessLevel = (typeof PRINCIPAL_ACCESS_LEVELS)[number]

/** The shell each level writes. Must be a member of `ALLOWED_PRINCIPAL_SHELLS`. */
const SHELL_FOR_LEVEL: Readonly<Record<PrincipalAccessLevel, string>> = {
  none: '/bin/false',
  sftp: DEFAULT_PRINCIPAL_SHELL,
  shell: '/bin/bash',
}

/**
 * Unix group each level maps to, mirroring `accessGroups` in
 * `turbopaneld/orchestration/runtime-registry.json`.
 *
 * The control plane cannot import across repos, so this is a static mirror in
 * the same spirit as `./runtime-registry.ts`. It is used for display and for
 * building the deploy payload's *intent*; the daemon resolves the real group
 * names from the registry it imports directly, so a drift here can only ever
 * mislabel a UI string, never grant something.
 */
export const PRINCIPAL_ACCESS_GROUPS: Readonly<
  Record<Exclude<PrincipalAccessLevel, 'none'>, string>
> = {
  sftp: 'tpsftp',
  shell: 'tpshell',
}

/**
 * Additive credential group, not a level: membership turns
 * `PasswordAuthentication` on in the daemon's `sshd` drop-in, and always rides
 * alongside the level group above — a password with nothing it may sign in
 * *as* grants nothing. Mirrors `accessGroups.password` in the daemon registry,
 * with the same drift-can-only-mislabel property as the levels.
 */
export const PRINCIPAL_PASSWORD_GROUP = 'tppasswd'

export function isPrincipalAccessLevel(
  value: unknown,
): value is PrincipalAccessLevel {
  return typeof value === 'string' &&
    (PRINCIPAL_ACCESS_LEVELS as readonly string[]).includes(value)
}

/** The shell to persist for a level. */
export function shellForAccessLevel(level: PrincipalAccessLevel): string {
  return SHELL_FOR_LEVEL[level]
}

/**
 * The level a stored shell encodes.
 *
 * Anything unrecognized reads as `none`. Fail-closed is the only defensible
 * default: an account whose shell the panel cannot interpret is one the panel
 * should not be handing out SSH access for.
 */
export function accessLevelForShell(
  shell: string | null | undefined,
): PrincipalAccessLevel {
  switch (shell) {
    case '/bin/bash':
    case '/bin/sh':
      return 'shell'
    case '/usr/sbin/nologin':
    case '/sbin/nologin':
      return 'sftp'
    default:
      return 'none'
  }
}

/**
 * What the account can actually do, given the credentials it holds.
 *
 * Separate from {@link accessLevelForShell} because the two answer different
 * questions: that one is "what did the operator ask for", this one is "what
 * happens if they try to connect right now". The UI needs both — an account set
 * to `shell` with zero keys should read as *Shell (no keys yet)*, not as
 * *Shell*, and not as *No access*.
 *
 * A key **or** an enabled password counts: either is something to present, and
 * an account with only a password must not be resolved to `none` or the daemon
 * would strip the very group its `sshd` Match block hangs from.
 */
export function effectivePrincipalAccess(
  shell: string | null | undefined,
  keyCount: number,
  passwordEnabled = false,
): PrincipalAccessLevel {
  const intended = accessLevelForShell(shell)
  return keyCount > 0 || passwordEnabled ? intended : 'none'
}

/**
 * Access groups a principal should hold — the value the deploy payload carries.
 *
 * Empty for `none` **and** for an account with no credential at all. Both are
 * real revocations and the daemon removes the membership either way; the point
 * of resolving it here rather than daemon-side is the doctrine the entitlement
 * work established — the control plane decides the effective set, the daemon
 * reconciles to it.
 *
 * {@link PRINCIPAL_PASSWORD_GROUP} is included only alongside a level group:
 * password sign-in with no level would be a group that unlocks a door onto
 * nothing, and stripping it when the level drops to `none` is what makes
 * suspending an account suspend *both* credentials.
 */
export function accessGroupsFor(
  shell: string | null | undefined,
  keyCount: number,
  passwordEnabled = false,
): readonly string[] {
  const level = effectivePrincipalAccess(shell, keyCount, passwordEnabled)
  if (level === 'none') return []
  return passwordEnabled
    ? [PRINCIPAL_ACCESS_GROUPS[level], PRINCIPAL_PASSWORD_GROUP]
    : [PRINCIPAL_ACCESS_GROUPS[level]]
}

/** Operator-facing label for a level. */
export function principalAccessLabel(level: PrincipalAccessLevel): string {
  switch (level) {
    case 'shell':
      return 'Shell'
    case 'sftp':
      return 'Files only'
    default:
      return 'No access'
  }
}
