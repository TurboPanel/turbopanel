/**
 * Typed-name confirmation for the deletes that remove the most: a server, a
 * project, an environment, a managed database, a Hosting Account. The caller
 * passes `?confirmName=<exact name>`; anything else is refused with 400
 * `confirm_name_required` before anything is stopped or removed.
 */
import type { Context } from 'hono'
import type { AppEnv } from '../app/app.ts'

/** The error code of a delete refused for a missing or wrong confirmation name. */
export const CONFIRM_NAME_REQUIRED_ERROR = 'confirm_name_required'

/**
 * The name the caller has to type: the first candidate that is not blank,
 * trimmed (a server without a name goes by its hostname, then its id). The web
 * interface shows the same value.
 */
export function confirmationName(...candidates: ReadonlyArray<string | null | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? ''
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** True when `typed` is exactly `expected` (case and spaces count) and `expected` is not empty. */
export function confirmNameMatches(typed: string | undefined, expected: string): boolean {
  return expected !== '' && typed === expected
}

/** The message of the 400, e.g. "Type the server name to delete this server." */
export function confirmNameMessage(noun: string): string {
  return `Type the ${noun} name to delete this ${noun}.`
}

/**
 * A 400 `confirm_name_required` when `?confirmName` is not exactly `expected`,
 * or null when the delete may go on.
 */
export function refuseUnlessNameConfirmed(
  c: Context<AppEnv>,
  noun: string,
  expected: string
): Response | null {
  if (confirmNameMatches(c.req.query('confirmName'), expected)) return null
  return c.json({ error: CONFIRM_NAME_REQUIRED_ERROR, message: confirmNameMessage(noun) }, 400)
}
