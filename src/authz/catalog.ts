/**
 * Static authorization catalog: access profiles and permissions are compile-time
 * constants defined in code (not runtime-editable, not DB rows).
 *
 * Distinct from `user.role` (instance authority, e.g. superadmin).
 */

export const PERMISSIONS = [
  'organization:ro',
  'organization:rw',
  'organization:members',
  'organization:billing',
  'team:ro',
  'team:rw',
  'team:members',
  'realm:ro',
  'realm:rw',
  'environment:ro',
  'environment:rw',
  'environment:deploy',
  'project:ro',
  'project:rw',
  'project:deploy',
  'service:ro',
  'service:rw',
  'service:restart',
  'service:logs',
  'server:ro',
  'server:rw',
  'server:ssh',
  'server:reboot',
  'hosting:ro',
  'hosting:rw',
  'hosting:reload',
] as const

export type PermissionKey = (typeof PERMISSIONS)[number]

export const ACCESS_PROFILES = {
  owner: [...PERMISSIONS],
  manager: [
    'organization:ro',
    'organization:rw',
    'organization:members',
    'team:ro',
    'team:rw',
    'team:members',
    'service:logs',
    'realm:ro',
    'realm:rw',
    'environment:ro',
    'environment:rw',
    'environment:deploy',
    'project:ro',
    'project:rw',
    'project:deploy',
    'service:ro',
    'service:rw',
    'service:restart',
    'service:logs',
    'server:ro',
    'server:rw',
    'server:ssh',
    'server:reboot',
    'hosting:ro',
    'hosting:rw',
    'hosting:reload',
  ],
  member: [
    'organization:ro',
    'team:ro',
    'realm:ro',
    'environment:ro',
    'project:ro',
    'service:ro',
    'server:ro',
    'hosting:ro',
  ],
  deployer: [
    'organization:ro',
    'team:ro',
    'realm:ro',
    'environment:ro',
    'environment:deploy',
    'project:ro',
    'project:deploy',
    'service:ro',
    'service:restart',
    'service:logs',
    'server:ro',
    'hosting:ro',
    'hosting:reload',
  ],
  operator: [
    'organization:ro',
    'team:ro',
    'realm:ro',
    'environment:ro',
    'project:ro',
    'service:ro',
    'service:rw',
    'service:restart',
    'service:logs',
    'server:ro',
    'server:rw',
    'server:ssh',
    'server:reboot',
    'hosting:ro',
    'hosting:rw',
    'hosting:reload',
  ],
  readonly: [
    'organization:ro',
    'team:ro',
    'realm:ro',
    'environment:ro',
    'project:ro',
    'service:ro',
    'server:ro',
    'hosting:ro',
  ],
  billing: [
    'organization:ro',
    'organization:billing',
    'team:ro',
  ],
} as const satisfies Record<string, readonly PermissionKey[]>

export type AccessProfileKey = keyof typeof ACCESS_PROFILES

export const RESOURCE_KINDS = [
  'organization',
  'realm',
  'environment',
  'project',
  'service',
  'server',
  'hosting',
] as const

export const ACCESS_PROFILE_DISPLAY_NAMES: Record<AccessProfileKey, string> = {
  owner: 'Owner',
  manager: 'Manager',
  member: 'Member',
  deployer: 'Deployer',
  operator: 'Operator',
  readonly: 'Read-only',
  billing: 'Billing',
}

export const PERMISSION_DISPLAY_NAMES: Record<PermissionKey, string> = {
  'organization:ro': 'View organization',
  'organization:rw': 'Manage organization',
  'organization:members': 'Manage organization members',
  'organization:billing': 'Manage organization billing',
  'team:ro': 'View teams',
  'team:rw': 'Manage teams',
  'team:members': 'Manage team members',
  'realm:ro': 'View realms',
  'realm:rw': 'Manage realms',
  'environment:ro': 'View environments',
  'environment:rw': 'Manage environments',
  'environment:deploy': 'Deploy environments',
  'project:ro': 'View projects',
  'project:rw': 'Manage projects',
  'project:deploy': 'Deploy projects',
  'service:ro': 'View services',
  'service:rw': 'Manage services',
  'service:restart': 'Restart services',
  'service:logs': 'View service logs',
  'server:ro': 'View servers',
  'server:rw': 'Manage servers',
  'server:ssh': 'SSH to servers',
  'server:reboot': 'Reboot servers',
  'hosting:ro': 'View hosting',
  'hosting:rw': 'Manage hosting',
  'hosting:reload': 'Reload hosting',
}

const PERMISSION_KEY_SET = new Set<string>(PERMISSIONS)

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value)
}

export function isAccessProfileKey(value: string): value is AccessProfileKey {
  return Object.hasOwn(ACCESS_PROFILES, value)
}

export function accessProfilesGrantingPermission(
  permissionKey: PermissionKey,
): AccessProfileKey[] {
  return (Object.keys(ACCESS_PROFILES) as AccessProfileKey[]).filter((key) =>
    (ACCESS_PROFILES[key] as readonly PermissionKey[]).includes(permissionKey),
  )
}

export function getAccessProfileCatalog(): Array<{
  key: AccessProfileKey
  displayName: string
  permissions: readonly PermissionKey[]
}> {
  return (Object.keys(ACCESS_PROFILES) as AccessProfileKey[])
    .toSorted()
    .map((key) => ({
      key,
      displayName: ACCESS_PROFILE_DISPLAY_NAMES[key],
      permissions: [...ACCESS_PROFILES[key]],
    }))
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
