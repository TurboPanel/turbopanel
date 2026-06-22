import type { PermissionKey } from './catalog.ts'

/** Permission required to list, create, or revoke access grants on any resource. */
export const ACCESS_MANAGEMENT_PERMISSION: PermissionKey = 'organization:own'

/**
 * Permission required to list, create, or revoke access grants on a resource.
 * The evaluator resolves the entity's org and checks org-level ownership.
 */
export function getAccessManagementPermission(_kind: string): PermissionKey {
  return ACCESS_MANAGEMENT_PERMISSION
}
