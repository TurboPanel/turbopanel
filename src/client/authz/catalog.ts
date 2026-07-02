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
] as const

export type PermissionKey = (typeof PERMISSIONS)[number]

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
] as const

/** Entity kinds that may appear on access_grant rows (resource tree + team). */
export const GRANT_ENTITY_TYPES = [
  ...RESOURCE_KINDS,
  'team',
] as const

export const ENTITY_TYPES = [
  'organization', 'team', 'workspace', 'environment',
  'project', 'service', 'hosting', 'server', 'variable', 'managed',
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

// Future: 'apikey' will be added here when API key auth is implemented
export const SUBJECT_TYPES = ['user', 'team', 'member'] as const
export type SubjectType = (typeof SUBJECT_TYPES)[number]

export const PERMISSION_DISPLAY_NAMES: Record<PermissionKey, string> = {
  'organization:own': 'Organization owner',
  'organization:manage': 'Organization manager',
  'team:own': 'Team owner',
  'team:manage': 'Team manager',
}

const PERMISSION_KEY_SET = new Set<string>(PERMISSIONS)
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES)
const GRANT_ENTITY_TYPE_SET = new Set<string>(GRANT_ENTITY_TYPES)
const SUBJECT_TYPE_SET = new Set<string>(SUBJECT_TYPES)

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value)
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
  key: PermissionKey
  displayName: string
}> {
  return [...PERMISSIONS].toSorted().map((key) => ({
    key,
    displayName: PERMISSION_DISPLAY_NAMES[key],
  }))
}
