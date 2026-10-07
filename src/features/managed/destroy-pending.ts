/**
 * Is a destroy of this cluster already queued or running?
 *
 * A `managed.destroy` deletes the `managed` row when it succeeds, and the
 * bindings of its logins go with that row. A binding created after the destroy
 * was queued would be removed without anyone being told, so binding creation
 * refuses while a destroy is outstanding. The gated primary destroy of a
 * multi-member cluster is only enqueued once the replica destroys finish, so
 * the replica commands (still non-terminal until then) are what this sees.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command } from '../../db/schema.ts'
import { COMMAND_STATUSES, TERMINAL_COMMAND_STATUSES } from '../commands/types.ts'

const OUTSTANDING_COMMAND_STATUSES = COMMAND_STATUSES.filter(
  (status) => !TERMINAL_COMMAND_STATUSES.has(status)
)

export async function hasOutstandingManagedDestroy(db: Db, managedId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: command.id })
    .from(command)
    .where(
      and(
        eq(command.name, 'managed.destroy'),
        inArray(command.status, OUTSTANDING_COMMAND_STATUSES),
        sql`${command.context}->>'managedId' = ${managedId}`
      )
    )
    .limit(1)
  return row !== undefined
}
