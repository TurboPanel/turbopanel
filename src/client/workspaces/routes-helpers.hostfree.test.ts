/**
 * Host-free coverage for workspace route pure validation helpers.
 */

import { assertEquals } from 'jsr:@std/assert'
import {
  parseWorkspaceCreateNames,
  parseWorkspacePatchNames,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseWorkspaceCreateNames validates names', () => {
  const ok = parseWorkspaceCreateNames({ name: 'Team A', description: 'Primary' })
  if (!ok.ok) throw new TypeError('expected valid workspace names')
  assertEquals(ok.displayName, 'Team A')
  assertEquals(ok.description, 'Primary')
  assertEquals(parseWorkspaceCreateNames({ name: 'bad/name' }).ok, false)
})

test('parseWorkspacePatchNames accepts partial updates', () => {
  const parsed = parseWorkspacePatchNames({ description: 'Updated' })
  if (!parsed.ok) throw new TypeError('expected valid patch names')
  assertEquals(parsed.patch.description, 'Updated')
  assertEquals('name' in parsed.patch, false)
  assertEquals(typeof parsed.patch.updatedAt, 'string')
})

test('parseWorkspacePatchNames rejects non-string description', () => {
  assertEquals(parseWorkspacePatchNames({ description: 1 }).ok, false)
})
