import { assertEquals } from '@std/assert'
import {
  ACCESS_MANAGEMENT_PERMISSION,
  getAccessManagementPermission,
} from './access-management.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('getAccessManagementPermission always requires organization ownership', () => {
  assertEquals(getAccessManagementPermission('organization'), ACCESS_MANAGEMENT_PERMISSION)
  assertEquals(getAccessManagementPermission('team'), ACCESS_MANAGEMENT_PERMISSION)
  assertEquals(getAccessManagementPermission('workspace'), ACCESS_MANAGEMENT_PERMISSION)
  assertEquals(ACCESS_MANAGEMENT_PERMISSION, 'organization:own')
})
