import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { nowIso } from '../commands/ids.ts'
import { environment } from './schema.ts'

/**
 * Atomically increment `environment.generation` and return the new value.
 * One bump per deploy plan (then fanned into `deployment.desired_generation`).
 */
export async function bumpEnvironmentGeneration(
  db: Db,
  environmentId: string,
): Promise<number> {
  const rows = await db
    .update(environment)
    .set({
      generation: sql`${environment.generation} + 1`,
      updatedAt: nowIso(),
    })
    .where(eq(environment.id, environmentId))
    .returning({ generation: environment.generation })

  const row = rows[0]
  if (!row) {
    throw new TypeError(`environment ${environmentId} not found`)
  }
  return row.generation
}
