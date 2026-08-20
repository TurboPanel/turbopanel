/**
 * Host-free coverage for team list route pure helpers.
 */

import { assertEquals } from '@std/assert'
import { teamsListPayload } from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Platform',
  organizationId: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

test('teamsListPayload hides rows when caller cannot manage', () => {
  assertEquals(teamsListPayload(false, [row]), { teams: [] })
})

test('teamsListPayload returns a shallow copy when manageable', () => {
  const payload = teamsListPayload(true, [row])
  assertEquals(payload.teams.length, 1)
  assertEquals(payload.teams[0]?.name, 'Platform')
  assertEquals(payload.teams[0] === row, false)
})
