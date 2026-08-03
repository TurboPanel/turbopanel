import { assertEquals } from 'jsr:@std/assert'
import {
  normalizeDisplayNameKey,
  PROJECT_NAME_IN_USE_ERROR,
  WORKSPACE_NAME_IN_USE_ERROR,
} from './display-name-uniqueness.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('normalizeDisplayNameKey trims and lowercases', () => {
  assertEquals(normalizeDisplayNameKey('  My Project  '), 'my project')
  assertEquals(normalizeDisplayNameKey('DEFAULT Workspace'), 'default workspace')
})

test('name-in-use error codes stay stable for API clients', () => {
  assertEquals(PROJECT_NAME_IN_USE_ERROR, 'project_name_in_use')
  assertEquals(WORKSPACE_NAME_IN_USE_ERROR, 'workspace_name_in_use')
})
