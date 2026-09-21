/**
 * Workspace kind discriminator (`user` | `turbopanel`).
 *
 * Workers-safe: no `@std/*`, no Deno-only APIs.
 */

export const WORKSPACE_KINDS = ['user', 'turbopanel'] as const

export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

/** Operator-created workspace discriminator (default). */
export const WORKSPACE_KIND_USER: WorkspaceKind = 'user'

/** Machine / platform workspace discriminator — one TurboPanel workspace per org. */
export const WORKSPACE_KIND_TURBOPANEL: WorkspaceKind = 'turbopanel'

/** @deprecated Prefer {@link WORKSPACE_KIND_TURBOPANEL}. */
export const WORKSPACE_KIND_SYSTEM = WORKSPACE_KIND_TURBOPANEL

export function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return typeof value === 'string' &&
    (WORKSPACE_KINDS as readonly string[]).includes(value)
}

/**
 * Parse a workspace kind. Anything other than exact {@link WORKSPACE_KIND_TURBOPANEL}
 * becomes `'user'`.
 */
export function parseWorkspaceKind(value: unknown): WorkspaceKind {
  return value === WORKSPACE_KIND_TURBOPANEL
    ? WORKSPACE_KIND_TURBOPANEL
    : WORKSPACE_KIND_USER
}
