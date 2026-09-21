import { assertEquals } from '@std/assert'
import {
  isWorkspaceKind,
  parseWorkspaceKind,
  WORKSPACE_KIND_SYSTEM,
  WORKSPACE_KIND_USER,
  WORKSPACE_KINDS,
} from './workspace-kind.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('WORKSPACE_KINDS lists user and turbopanel discriminators', () => {
  assertEquals([...WORKSPACE_KINDS], ['user', 'turbopanel'])
  assertEquals(WORKSPACE_KIND_USER, 'user')
  assertEquals(WORKSPACE_KIND_SYSTEM, 'turbopanel')
})

test('isWorkspaceKind accepts only exact kind strings', () => {
  assertEquals(isWorkspaceKind('user'), true)
  assertEquals(isWorkspaceKind('turbopanel'), true)
  assertEquals(isWorkspaceKind('System'), false)
  assertEquals(isWorkspaceKind(null), false)
  assertEquals(isWorkspaceKind(1), false)
})

test('parseWorkspaceKind maps unknown values to user', () => {
  assertEquals(parseWorkspaceKind('turbopanel'), WORKSPACE_KIND_SYSTEM)
  assertEquals(parseWorkspaceKind(WORKSPACE_KIND_SYSTEM), WORKSPACE_KIND_SYSTEM)
  assertEquals(parseWorkspaceKind(undefined), WORKSPACE_KIND_USER)
  assertEquals(parseWorkspaceKind('systemic'), WORKSPACE_KIND_USER)
  assertEquals(parseWorkspaceKind(null), WORKSPACE_KIND_USER)
})
