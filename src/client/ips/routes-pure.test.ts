import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  assertIpScopeFkRules,
  isIpAddressUniqueViolation,
  parseCreateIpAddress,
} from './ip-create-validation.ts'

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

async function expectInvalidRequest(response: Response | { address: string }): Promise<void> {
  if (!(response instanceof Response)) {
    throw new TypeError('expected invalid request response')
  }
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'Invalid request' })
}

test('isIpAddressUniqueViolation matches org and VPN overlay indexes', () => {
  const orgErr = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_ip_org_address"'),
    { code: '23505' },
  )
  const vpnErr = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_ip_vpn_address"'),
    { code: '23505' },
  )
  assertEquals(isIpAddressUniqueViolation(orgErr), true)
  assertEquals(isIpAddressUniqueViolation(vpnErr), true)
  assertEquals(isIpAddressUniqueViolation({ code: '23505', message: 'other' }), false)
})

test('parseCreateIpAddress rejects client-supplied version and invalid addresses', async () => {
  const c = mockContext()

  await expectInvalidRequest(parseCreateIpAddress(c, { address: '203.0.113.10', version: 4 }))
  await expectInvalidRequest(parseCreateIpAddress(c, { address: 'not-an-ip' }))

  const parsed = parseCreateIpAddress(c, { address: ' 203.0.113.10 ' })
  if (parsed instanceof Response) {
    throw new TypeError('expected parsed IP address')
  }
  assertEquals(parsed.address, '203.0.113.10')
})

test('assertIpScopeFkRules enforces VPN scope and free-pool datacenter rules', async () => {
  const c = mockContext()

  await expectInvalidRequest(assertIpScopeFkRules(c, 'vpn', {}))
  await expectInvalidRequest(assertIpScopeFkRules(c, 'public', { vpnId: 'vpn-1' }))
  await expectInvalidRequest(assertIpScopeFkRules(c, 'datacenter', {
    datacenterId: 'dc-1',
    serverId: 'srv-1',
  }))
  assertEquals(assertIpScopeFkRules(c, 'vpn', { vpnId: 'vpn-1' }), null)
  assertEquals(assertIpScopeFkRules(c, 'datacenter', { datacenterId: 'dc-1' }), null)
})
