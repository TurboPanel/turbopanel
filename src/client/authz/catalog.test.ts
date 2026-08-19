import { assertEquals } from 'jsr:@std/assert'
import {
  ENTITY_TYPES,
  getPermissionCatalog,
  GRANT_ENTITY_TYPES,
  GRANTABLE_PERMISSIONS,
  isEntityType,
  isGrantablePermissionKey,
  isGrantEntityType,
  isPermissionKey,
  isSubjectType,
  isSystemPermissionKey,
  PERMISSIONS,
  PERMISSION_DISPLAY_NAMES,
  RESOURCE_KINDS,
  SUBJECT_TYPES,
} from './catalog.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isPermissionKey accepts catalog keys and rejects unknown strings', () => {
  for (const key of PERMISSIONS) {
    assertEquals(isPermissionKey(key), true)
  }
  assertEquals(isPermissionKey('organization:read'), false)
  assertEquals(isPermissionKey(''), false)
  assertEquals(isPermissionKey('SYSTEM:READ'), false)
})

test('isSystemPermissionKey distinguishes platform permissions', () => {
  assertEquals(isSystemPermissionKey('system:read'), true)
  assertEquals(isSystemPermissionKey('system:operate'), true)
  assertEquals(isSystemPermissionKey('system:manage'), true)
  assertEquals(isSystemPermissionKey('organization:own'), false)
  assertEquals(isSystemPermissionKey('team:manage'), false)
})

test('isEntityType and isGrantEntityType enforce their respective catalogs', () => {
  assertEquals(isEntityType('workspace'), true)
  assertEquals(isEntityType('principal'), true)
  assertEquals(isEntityType('license'), false)

  for (const kind of GRANT_ENTITY_TYPES) {
    assertEquals(isGrantEntityType(kind), true)
    assertEquals(isEntityType(kind), true)
  }
  assertEquals(isGrantEntityType('principal'), false)
  assertEquals(isGrantEntityType('fabric'), false)
})

test('isGrantablePermissionKey excludes system:manage', () => {
  for (const key of GRANTABLE_PERMISSIONS) {
    assertEquals(isGrantablePermissionKey(key), true)
  }
  assertEquals(isGrantablePermissionKey('system:manage'), false)
  assertEquals(isGrantablePermissionKey('organization:read'), false)
})

test('isSubjectType accepts user, team, and organization', () => {
  for (const subject of SUBJECT_TYPES) {
    assertEquals(isSubjectType(subject), true)
  }
  assertEquals(isSubjectType('organization'), true)
  assertEquals(isSubjectType('member'), false)
  assertEquals(isSubjectType('apikey'), false)
})

test('getPermissionCatalog returns sorted grantable keys with display names', () => {
  const catalog = getPermissionCatalog()
  assertEquals(catalog.length, GRANTABLE_PERMISSIONS.length)

  const keys: string[] = catalog.map((entry) => entry.key)
  const sorted = [...keys].sort((a, b) => a.localeCompare(b))
  assertEquals(keys, sorted)
  assertEquals(keys.includes('system:manage'), false)
  assertEquals(keys.includes('system:operate'), true)

  for (const entry of catalog) {
    assertEquals(entry.displayName, PERMISSION_DISPLAY_NAMES[entry.key])
  }
})

test('RESOURCE_KINDS and ENTITY_TYPES include workspace-tree leaves used by authz', () => {
  assertEquals(RESOURCE_KINDS.includes('managed'), true)
  assertEquals(ENTITY_TYPES.includes('storage'), true)
  const entityTypes: readonly string[] = ENTITY_TYPES
  assertEquals(entityTypes.includes('peer'), false)
  assertEquals(entityTypes.includes('vpn'), false)
  assertEquals(entityTypes.includes('fabric'), false)
})
