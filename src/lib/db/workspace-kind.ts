/**
 * Workspace kind discriminator (`user` | `system`).
 *
 * Workers-safe: no `@std/*`, no Deno-only APIs.
 */

export const WORKSPACE_KINDS = ['user', 'system'] as const

export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

/** Operator-created workspace discriminator (default). */
export const WORKSPACE_KIND_USER: WorkspaceKind = 'user'

/** Machine / platform workspace discriminator — one system workspace per org. */
export const WORKSPACE_KIND_SYSTEM: WorkspaceKind = 'system'

export function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return typeof value === 'string' &&
    (WORKSPACE_KINDS as readonly string[]).includes(value)
}

/**
 * Parse a workspace kind. Anything other than exact {@link WORKSPACE_KIND_SYSTEM}
 * becomes `'user'`.
 */
export function parseWorkspaceKind(value: unknown): WorkspaceKind {
  return value === WORKSPACE_KIND_SYSTEM
    ? WORKSPACE_KIND_SYSTEM
    : WORKSPACE_KIND_USER
}
