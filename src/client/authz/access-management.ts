import type { PermissionKey } from './catalog.ts'

/**
 * Permission required to list, create, or revoke access grants on a resource.
 * Organization and team scopes use `*:members`; all other kinds use `*:rw`.
 */
export function getAccessManagementPermission(kind: string): PermissionKey {
  if (kind === 'organization') return 'organization:members'
  if (kind === 'team') return 'team:members'
  return `${kind}:rw` as PermissionKey
}
