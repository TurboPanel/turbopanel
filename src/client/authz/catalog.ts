/**
 * Static authorization catalog: permissions are compile-time constants defined
 * in code (not runtime-editable, not DB rows).
 *
 * Distinct from `user.role` (instance authority, e.g. superadmin).
 */

export const PERMISSIONS = [
  'organization:own',
  'organization:manage',
  'team:own',
  'team:manage',
  'system:read',
  'system:operate',
  'system:manage',
] as const

export type PermissionKey = (typeof PERMISSIONS)[number]

/** Permissions that may appear on `grant` rows. `system:manage` is superadmin-only. */
export type GrantablePermissionKey = Exclude<PermissionKey, 'system:manage'>

export const GRANTABLE_PERMISSIONS: readonly GrantablePermissionKey[] =
  PERMISSIONS.filter((key): key is GrantablePermissionKey => key !== 'system:manage')

export const RESOURCE_KINDS = [
  'organization',
  'workspace',
  'environment',
  'project',
  'service',
  'server',
  'hosting',
  'variable',
  'managed',
  'container',
  'tls',
  'principal',
  'storage',
  'network',
  'datacenter',
  'ip',
] as const

/**
 * Entity kinds that may appear on access_grant rows (resource tree + team).
 * `principal` is intentionally omitted — grants stay org/team-scoped; principal
 * participates in `can()` / `listVisible()` via {@link RESOURCE_KINDS} only.
 */
export const GRANT_ENTITY_TYPES = [
  'organization',
  'workspace',
  'environment',
  'project',
  'service',
  'server',
  'hosting',
  'variable',
  'managed',
  'container',
  'tls',
  'team',
] as const

export const ENTITY_TYPES = [
  'organization', 'team', 'workspace', 'environment',
  'project', 'service', 'hosting', 'server', 'variable', 'managed',
  'container', 'tls', 'principal', 'storage',
  'network', 'datacenter', 'ip',
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

// Future: 'apikey' will be added here when API key auth is implemented
export const SUBJECT_TYPES = ['user', 'team', 'organization'] as const
export type SubjectType = (typeof SUBJECT_TYPES)[number]

export const PERMISSION_DISPLAY_NAMES: Record<PermissionKey, string> = {
  'organization:own': 'Organization owner',
  'organization:manage': 'Organization manager',
  'team:own': 'Team owner',
  'team:manage': 'Team manager',
  'system:read': 'System inspect',
  'system:operate': 'System operate',
  'system:manage': 'System administer',
}

const PERMISSION_KEY_SET = new Set<string>(PERMISSIONS)
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES)
const GRANT_ENTITY_TYPE_SET = new Set<string>(GRANT_ENTITY_TYPES)
const SUBJECT_TYPE_SET = new Set<string>(SUBJECT_TYPES)

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value)
}

/** True when the key may be written as an access grant (excludes `system:manage`). */
export function isGrantablePermissionKey(
  value: string,
): value is GrantablePermissionKey {
  return isPermissionKey(value) && value !== 'system:manage'
}

/** True when the key is a platform `system:*` permission (exact-match grants). */
export function isSystemPermissionKey(value: PermissionKey): boolean {
  return value.startsWith('system:')
}

export function isEntityType(value: string): value is EntityType {
  return ENTITY_TYPE_SET.has(value)
}

export function isGrantEntityType(
  value: string,
): value is (typeof GRANT_ENTITY_TYPES)[number] {
  return GRANT_ENTITY_TYPE_SET.has(value)
}

export function isSubjectType(value: string): value is SubjectType {
  return SUBJECT_TYPE_SET.has(value)
}

export function getPermissionCatalog(): Array<{
  key: GrantablePermissionKey
  displayName: string
}> {
  return [...GRANTABLE_PERMISSIONS]
    .toSorted((a, b) => a.localeCompare(b))
    .map((key) => ({
      key,
      displayName: PERMISSION_DISPLAY_NAMES[key],
    }))
}
