import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import {
  COLOCATED_SERVER_DELETE_BLOCKED_REASON,
  SERVER_HAS_BLOCKERS_CODE,
  SERVER_HAS_BLOCKERS_ERROR,
  colocatedServerDeleteBlockedReason,
  serverDeleteBlockersResponse,
  type ServerDeleteBlocker,
} from './delete-guards.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(): Context {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context
}

test('colocatedServerDeleteBlockedReason returns the stable operator copy', () => {
  assertEquals(
    colocatedServerDeleteBlockedReason(),
    COLOCATED_SERVER_DELETE_BLOCKED_REASON,
  )
})

test('serverDeleteBlockersResponse returns 409 with code and blockers', async () => {
  const blockers: ServerDeleteBlocker[] = [
    { kind: 'network', count: 2 },
    { kind: 'container', count: 1 },
  ]
  const response = serverDeleteBlockersResponse(mockContext(), blockers)
  assertEquals(response.status, 409)
  assertEquals(await response.json(), {
    error: SERVER_HAS_BLOCKERS_ERROR,
    code: SERVER_HAS_BLOCKERS_CODE,
    blockers,
  })
})
