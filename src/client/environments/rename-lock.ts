/**
 * The environment name is the scope folder name on every server, so it can
 * change only while no folder exists under it. This module is the one place
 * that decides that for `PATCH /environments/:id` and for the delete route.
 *
 * What blocks: any `folder` row of the environment in a state other than
 * `missing` (so a `removing` row waiting for an offline server still counts),
 * or a deploy, lifecycle or stop command that has not finished. Assets in the
 * `common` scope carry no environment id and never block. When it refuses, the
 * body lists up to 20 blocking folders with the names a person can recognise.
 *
 * A rename takes `FOR UPDATE` on the environment row. A folder insert for the
 * environment takes the matching `FOR KEY SHARE` through its foreign key, so
 * one waits for the other. A deploy dispatch does not take that lock, so a
 * command queued between the running-command check and the commit is possible;
 * the dispatch paths and the folder insert should call `lockEnvironmentRow`
 * first. Moving an environment to another server (`serverId`) is not locked by
 * folders.
 */
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { isValidEnvironmentName } from '../../contracts/directory-names.ts'
import type { Db } from '../../db/connection.ts'
import { environment } from '../../db/schema.ts'
import {
  ENVIRONMENT_DEPLOY_RUNNING_ERROR,
  ENVIRONMENT_HAS_FOLDERS_ERROR,
  ENVIRONMENT_NAME_INVALID_ERROR,
  ENVIRONMENT_NAME_LOCKED_ERROR,
  environmentHasRunningCommand,
  listEnvironmentFolders,
  lockEnvironmentRow,
  type Reader,
} from '../../features/folders/records.ts'

export type EnvironmentRenameFields = {
  name?: string | null
  description?: string | null
  serverId?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

/** The 409 body: the error code, a plain sentence and the blocking folders. */
async function blockedBody(db: Reader, environmentId: string, error: string, message: string) {
  const { folders, total } = await listEnvironmentFolders(db, environmentId)
  return { error, message, folders, total }
}

const LOCKED_MESSAGE =
  "This environment's name is part of the folder path on your servers, so it cannot change while services or volumes have folders in it. Remove the listed ones first, or put assets that should not depend on the name in the shared (common) scope."

/**
 * Apply a PATCH. A change of name takes the environment row's lock, checks the
 * new name against the folder rule and the folder rows, then writes in the same
 * transaction; every other patch is a plain update. Returns a response when the
 * patch is refused, otherwise null.
 */
export async function updateEnvironmentChecked(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
  fields: EnvironmentRenameFields
): Promise<Response | null> {
  if (fields.name === undefined) {
    await db.update(environment).set(fields).where(eq(environment.id, environmentId))
    return null
  }
  const nextName = fields.name
  return await db.transaction(async (tx) => {
    if (!(await lockEnvironmentRow(tx, environmentId))) {
      return c.json({ error: 'Not found' }, 404)
    }
    const [current] = await tx
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.id, environmentId))
      .limit(1)
    if (current?.name !== nextName) {
      // A name that is not changing is accepted as is, so an environment named
      // before names became folder names can still be edited.
      if (!isValidEnvironmentName(nextName)) {
        return c.json(
          {
            error: ENVIRONMENT_NAME_INVALID_ERROR,
            message:
              'An environment name uses lowercase letters, digits, hyphens and underscores, starts with a letter or digit, is at most 32 characters, and is not a reserved word such as common, home or tmp.',
          },
          400
        )
      }
      const { total } = await listEnvironmentFolders(tx, environmentId, 0)
      if (total > 0) {
        return c.json(
          await blockedBody(tx, environmentId, ENVIRONMENT_NAME_LOCKED_ERROR, LOCKED_MESSAGE),
          409
        )
      }
      if (await environmentHasRunningCommand(tx, environmentId)) {
        return c.json(
          {
            error: ENVIRONMENT_DEPLOY_RUNNING_ERROR,
            message:
              'A deploy is running for this environment. Rename it when the deploy finishes.',
          },
          409
        )
      }
    }
    await tx.update(environment).set(fields).where(eq(environment.id, environmentId))
    return null
  })
}

/** Refuse to delete an environment while any folder exists under it. */
export async function refuseDeleteWhileFolders(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string
): Promise<Response | null> {
  const { total } = await listEnvironmentFolders(db, environmentId, 0)
  if (total === 0) return null
  return c.json(
    await blockedBody(
      db,
      environmentId,
      ENVIRONMENT_HAS_FOLDERS_ERROR,
      'This environment still has folders on your servers. Remove the listed services and volumes first.'
    ),
    409
  )
}
