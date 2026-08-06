import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  assertManagedNotBusy,
  isManagedStatus,
  requireManagedCreateServerId,
  resolveManagedTargetServerId,
} from './context.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

test('requireManagedCreateServerId returns the pin or 409', async () => {
  const c = mockContext()
  assertEquals(requireManagedCreateServerId(c, 'server-1'), 'server-1')

  const missing = requireManagedCreateServerId(c, null)
  if (!(missing instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(missing.status, 409)
  assertEquals(await missing.json(), { error: 'server_placement_required' })
})

test('resolveManagedTargetServerId returns managed.server_id or 409', async () => {
  const c = mockContext()
  assertEquals(resolveManagedTargetServerId(c, 'server-9'), 'server-9')

  const missing = resolveManagedTargetServerId(c, null)
  if (!(missing instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(missing.status, 409)
  assertEquals(await missing.json(), { error: 'server_placement_required' })
})

test('assertManagedNotBusy rejects applying only', async () => {
  const c = mockContext()
  assertEquals(assertManagedNotBusy(c, 'ready'), null)
  assertEquals(assertManagedNotBusy(c, null), null)

  const busy = assertManagedNotBusy(c, 'applying')
  if (!(busy instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(busy.status, 409)
  assertEquals(await busy.json(), { error: 'managed_busy' })
})

test('isManagedStatus accepts the persisted status set', () => {
  assertEquals(isManagedStatus('provisioning'), true)
  assertEquals(isManagedStatus('applying'), true)
  assertEquals(isManagedStatus('ready'), true)
  assertEquals(isManagedStatus('stopped'), true)
  assertEquals(isManagedStatus('failed'), true)
  assertEquals(isManagedStatus(null), false)
  assertEquals(isManagedStatus('weird'), false)
})
