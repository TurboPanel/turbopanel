import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  assertNetworkKindScope,
  buildNetworkCreateValues,
} from './network-scope.ts'

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

async function expectErrorResponse(
  response: Response | null,
  status: number,
  error: string,
): Promise<void> {
  if (response === null) {
    throw new TypeError('expected error response')
  }
  assertEquals(response.status, status)
  assertEquals(await response.json(), { error })
}

test('assertNetworkKindScope enforces datacenter and server scope rules', async () => {
  const c = mockContext()

  await expectErrorResponse(
    assertNetworkKindScope(c, 'datacenter', null, null),
    400,
    'network_scope_required',
  )
  await expectErrorResponse(
    assertNetworkKindScope(c, 'datacenter', 'dc-1', 'srv-1'),
    400,
    'network_single_scope_conflict',
  )
  assertEquals(assertNetworkKindScope(c, 'datacenter', 'dc-1', null), null)

  await expectErrorResponse(
    assertNetworkKindScope(c, 'server', null, null),
    400,
    'network_scope_required',
  )
  assertEquals(assertNetworkKindScope(c, 'server', null, 'srv-1'), null)

  await expectErrorResponse(
    assertNetworkKindScope(c, 'docker', 'dc-1', null),
    400,
    'network_single_scope_conflict',
  )
  assertEquals(assertNetworkKindScope(c, 'docker', null, null), null)
})

test('buildNetworkCreateValues omits null optional fields', () => {
  assertEquals(
    buildNetworkCreateValues({
      organizationId: 'org-1',
      kind: 'docker',
      datacenterId: undefined,
      serverId: undefined,
      displayName: null,
      cidr: null,
      metadata: null,
      options: { dockerNetworkName: 'shared-net' },
    }),
    {
      organizationId: 'org-1',
      kind: 'docker',
      options: { dockerNetworkName: 'shared-net' },
    },
  )

  assertEquals(
    buildNetworkCreateValues({
      organizationId: 'org-1',
      kind: 'datacenter',
      datacenterId: 'dc-1',
      serverId: null,
      displayName: 'Private LAN',
      cidr: '10.0.0.0/24',
      metadata: { note: 'primary' },
      options: null,
    }),
    {
      organizationId: 'org-1',
      kind: 'datacenter',
      datacenterId: 'dc-1',
      serverId: null,
      displayName: 'Private LAN',
      cidr: '10.0.0.0/24',
      metadata: { note: 'primary' },
    },
  )
})
