import { assertEquals } from '@std/assert'
import {
  collapseManagedSqlAccessScopes,
  compareManagedSqlAccessScopes,
  DEFAULT_MANAGED_SQL_ACCESS_SCOPE,
  isManagedSqlAccessScope,
  MANAGED_SQL_ACCESS_SCOPES,
  managedSqlAccessScopeLabel,
  managedSqlAccessScopeRank,
  UNEXPOSED_MANAGED_SQL_ACCESS_SCOPE,
  unionManagedSqlAccessScopes,
} from './access-scope.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('catalog order is narrowest to widest with public as the exposure default', () => {
  assertEquals(MANAGED_SQL_ACCESS_SCOPES, [
    'local',
    'datacenter',
    'turbofabric',
    'public',
  ])
  assertEquals(DEFAULT_MANAGED_SQL_ACCESS_SCOPE, 'public')
  assertEquals(UNEXPOSED_MANAGED_SQL_ACCESS_SCOPE, 'local')
})

test('isManagedSqlAccessScope accepts only catalog values', () => {
  for (const scope of MANAGED_SQL_ACCESS_SCOPES) {
    assertEquals(isManagedSqlAccessScope(scope), true)
  }
  for (const bogus of ['internet', 'vpn', 'LOCAL', '', 1, null, undefined, {}]) {
    assertEquals(isManagedSqlAccessScope(bogus), false)
  }
})

test('rank and compare put widest first for operator-facing primary endpoints', () => {
  assertEquals(managedSqlAccessScopeRank('local'), 1)
  assertEquals(managedSqlAccessScopeRank('public'), 4)
  assertEquals(compareManagedSqlAccessScopes('local', 'public'), 3)
  assertEquals(compareManagedSqlAccessScopes('public', 'local'), -3)
  assertEquals(compareManagedSqlAccessScopes('datacenter', 'datacenter'), 0)
})

test('unionManagedSqlAccessScopes dedupes and sorts widest first', () => {
  assertEquals(unionManagedSqlAccessScopes([]), [])
  assertEquals(unionManagedSqlAccessScopes([undefined, undefined]), [])
  assertEquals(
    unionManagedSqlAccessScopes(['local', 'turbofabric', 'local', undefined]),
    ['turbofabric', 'local'],
  )
  assertEquals(
    unionManagedSqlAccessScopes(['public', 'datacenter', 'turbofabric']),
    ['public', 'turbofabric', 'datacenter'],
  )
})

test('collapseManagedSqlAccessScopes drops narrower scopes when public is present', () => {
  assertEquals(collapseManagedSqlAccessScopes(['public', 'local', 'datacenter']), [
    'public',
  ])
  assertEquals(
    collapseManagedSqlAccessScopes(['turbofabric', 'local', 'datacenter']),
    ['turbofabric', 'datacenter', 'local'],
  )
  assertEquals(collapseManagedSqlAccessScopes([]), [])
})

test('managedSqlAccessScopeLabel uses operator-facing copy', () => {
  assertEquals(managedSqlAccessScopeLabel('local'), 'Local')
  assertEquals(managedSqlAccessScopeLabel('datacenter'), 'Datacenter')
  assertEquals(managedSqlAccessScopeLabel('turbofabric'), 'TurboFabric')
  assertEquals(managedSqlAccessScopeLabel('public'), 'Public')
})
