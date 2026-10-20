/**
 * Where a configuration edit sent to `PATCH /projects/:id` lands.
 *
 * A project's compose lives in two kinds of place: the Base (the project's own
 * compose, inherited by every environment) and each environment's own changes.
 * An edit to `options.compose` or `options.composeOverlays` therefore names its
 * target: `"base"` or an environment id. With one environment and no target the
 * edit goes to that environment, never to the Base. With several and no target
 * the request is refused, so nothing reaches the Base by accident.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment } from '../../db/schema.ts'
import { UUID_RE } from '../repositories/routes-helpers.ts'

export const EDIT_TARGET_REQUIRED_ERROR = 'edit_target_required'
export const EDIT_TARGET_INVALID_ERROR = 'edit_target_invalid'
export const EDIT_TARGET_MIXED_ERROR = 'edit_target_mixed'

/** The `options` keys that are configuration layers (the rest are project settings). */
export const CONFIGURATION_OPTION_KEYS = ['compose', 'composeOverlays'] as const

export type EditTarget =
  | { ok: true; kind: 'none' }
  | { ok: true; kind: 'base' }
  | { ok: true; kind: 'environment'; environmentId: string }
  | { ok: false; error: string; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function carriesConfiguration(body: Record<string, unknown>): boolean {
  return (
    isRecord(body.options) &&
    CONFIGURATION_OPTION_KEYS.some((key) => key in (body.options as object))
  )
}

export async function resolveEditTarget(
  db: Db,
  projectId: string,
  body: Record<string, unknown>
): Promise<EditTarget> {
  if (!carriesConfiguration(body)) return { ok: true, kind: 'none' }

  const rows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, projectId))
  const requested = body.target

  if (requested === 'base') return { ok: true, kind: 'base' }

  let environmentId: string
  if (requested === undefined || requested === null) {
    if (rows.length === 0) return { ok: true, kind: 'base' }
    if (rows.length > 1) {
      return {
        ok: false,
        error: EDIT_TARGET_REQUIRED_ERROR,
        message:
          "This project has more than one environment. Send target: an environment id, or 'base' to change what every environment inherits.",
      }
    }
    environmentId = rows[0]!.id
  } else if (typeof requested === 'string' && UUID_RE.test(requested)) {
    if (!rows.some((row) => row.id === requested)) {
      return {
        ok: false,
        error: EDIT_TARGET_INVALID_ERROR,
        message: 'target is not an environment of this project.',
      }
    }
    environmentId = requested
  } else {
    return {
      ok: false,
      error: EDIT_TARGET_INVALID_ERROR,
      message: "target must be 'base' or an environment id.",
    }
  }

  const options = body.options as Record<string, unknown>
  if (
    Object.keys(options).some(
      (key) => !(CONFIGURATION_OPTION_KEYS as readonly string[]).includes(key)
    )
  ) {
    return {
      ok: false,
      error: EDIT_TARGET_MIXED_ERROR,
      message:
        "Compose edits to an environment cannot carry project settings in the same request. Send the project settings separately with target 'base'.",
    }
  }
  return { ok: true, kind: 'environment', environmentId }
}
