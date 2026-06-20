import { and, eq, notInArray } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { permission, permit, role } from '../db/schema.ts'
import {
  PERMISSIONS,
  PERMISSION_DISPLAY_NAMES,
  ROLES,
  ROLE_DISPLAY_NAMES,
  type PermissionKey,
  type RoleKey,
} from './catalog.ts'
import { logInfo } from '../logger.ts'

export async function syncAuthzCatalog(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const permissionIds = new Map<PermissionKey, string>()

    for (const key of PERMISSIONS) {
      const [row] = await tx
        .insert(permission)
        .values({
          key,
          displayName: PERMISSION_DISPLAY_NAMES[key],
          description: null,
        })
        .onConflictDoUpdate({
          target: permission.key,
          set: {
            displayName: PERMISSION_DISPLAY_NAMES[key],
            description: null,
          },
        })
        .returning({ key: permission.key, id: permission.id })

      if (!row) {
        throw new Error(`permission upsert returned no row for ${key}`)
      }
      permissionIds.set(row.key as PermissionKey, row.id)
    }

    const roleIds = new Map<RoleKey, string>()

    for (const key of Object.keys(ROLES) as RoleKey[]) {
      const [row] = await tx
        .insert(role)
        .values({
          key,
          displayName: ROLE_DISPLAY_NAMES[key],
          description: null,
        })
        .onConflictDoUpdate({
          target: role.key,
          set: {
            displayName: ROLE_DISPLAY_NAMES[key],
            description: null,
          },
        })
        .returning({ key: role.key, id: role.id })

      if (!row) {
        throw new Error(`role upsert returned no row for ${key}`)
      }
      roleIds.set(row.key as RoleKey, row.id)
    }

    for (const roleKey of Object.keys(ROLES) as RoleKey[]) {
      const roleId = roleIds.get(roleKey)
      if (!roleId) {
        throw new Error(`missing role id for ${roleKey}`)
      }

      const expectedPermissionIds = ROLES[roleKey].map((permissionKey) => {
        const permissionId = permissionIds.get(permissionKey)
        if (!permissionId) {
          throw new Error(`missing permission id for ${permissionKey}`)
        }
        return permissionId
      })

      if (expectedPermissionIds.length > 0) {
        await tx
          .insert(permit)
          .values(
            expectedPermissionIds.map((permissionId) => ({
              roleId,
              permissionId,
            })),
          )
          .onConflictDoNothing()
      }

      if (expectedPermissionIds.length === 0) {
        await tx.delete(permit).where(eq(permit.roleId, roleId))
      } else {
        await tx
          .delete(permit)
          .where(
            and(
              eq(permit.roleId, roleId),
              notInArray(permit.permissionId, expectedPermissionIds),
            ),
          )
      }
    }
  })

  logInfo(
    'authz',
    `catalog synced: ${PERMISSIONS.length} permissions, ${Object.keys(ROLES).length} roles`,
  )
}
