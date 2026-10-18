import { type SQL, sql } from 'drizzle-orm'
import { command } from '../../db/schema.ts'

/**
 * `command.status` is one of the five statuses a command is still moving in.
 * The list is spelled out as literal text, not bound as parameters, so the
 * planner can match it to the partial indexes `idx_command_open` and
 * `idx_command_managed` (a bound list is invisible to it in a cached plan).
 * Pinned to the terminal list by `types.ts`: everything else is open.
 */
export function commandIsOpen(): SQL {
  return sql`${command.status} IN ('queued', 'dispatching', 'sent', 'acked', 'running')`
}
