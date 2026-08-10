import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  assertNetworkKindScope,
  buildNetworkCreateValues,
} from './network-scope.ts'
import {
  applyCidrPatch,
  parseCreateOrganizationId,
  parseNetworkKind,
  parseNetworkPatchFields,
  parseOptionalCidrField,
  parseOptionalDisplayNameField,
  parseUuidQueryParam,
  rejectImmutableNetworkScopePatch,
  requireDockerNetworkOptions,
  resolveKindQueryFilter,
} from './routes-pure.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(query: Record<string, string> = {}): Context<AppEnv> {
  return {
    req: {
      query(key: string) {
        return query[key]
      },
      header() {
        return undefined
      },
    },
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

test('assertNetworkKindScope enforces datacenter and docker scope rules', async () => {
  const c = mockContext() as Parameters<typeof assertNetworkKindScope>[0]

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

  assertEquals(assertNetworkKindScope(c, 'docker', null, 'srv-1'), null)
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
      name: 'Private LAN',
      cidr: '10.0.0.0/24',
      metadata: { note: 'primary' },
    },
  )
})

test('resolveKindQueryFilter accepts datacenter and docker only', async () => {
  const c = mockContext()
  assertEquals(resolveKindQueryFilter(c), undefined)
  assertEquals(resolveKindQueryFilter(mockContext({ kind: 'docker' })), 'docker')
  const bad = resolveKindQueryFilter(mockContext({ kind: 'vpn' }))
  if (!(bad instanceof Response)) throw new TypeError('expected response')
  assertEquals(bad.status, 400)
})

test('parseUuidQueryParam validates list filter UUIDs', async () => {
  const c = mockContext()
  const valid = '550e8400-e29b-41d4-a716-446655440000'
  assertEquals(parseUuidQueryParam(c, undefined), undefined)
  assertEquals(parseUuidQueryParam(c, `  ${valid}  `), valid)
  const bad = parseUuidQueryParam(c, 'not-a-uuid')
  if (!(bad instanceof Response)) throw new TypeError('expected response')
  assertEquals(bad.status, 400)
})

test('parseCreateOrganizationId rejects mismatched context organizationId', async () => {
  const orgId = '550e8400-e29b-41d4-a716-446655440000'
  const ok = parseCreateOrganizationId(
    mockContext({ organizationId: orgId }),
    { organizationId: orgId },
  )
  assertEquals(ok, orgId)

  const mismatch = parseCreateOrganizationId(
    mockContext({ organizationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }),
    { organizationId: orgId },
  )
  if (!(mismatch instanceof Response)) throw new TypeError('expected response')
  assertEquals(mismatch.status, 400)
  assertEquals(await mismatch.json(), { error: 'organizationId mismatch' })
})

test('parseNetworkKind and CIDR helpers validate create/patch input', async () => {
  const c = mockContext()
  assertEquals(parseNetworkKind(c, { kind: 'docker' }), 'docker')
  const badKind = parseNetworkKind(c, { kind: 'vpn' })
  if (!(badKind instanceof Response)) throw new TypeError('expected response')
  assertEquals(badKind.status, 400)

  assertEquals(parseOptionalDisplayNameField(c, {}), null)
  assertEquals(parseOptionalCidrField(c, { cidr: '10.0.0.0/24' }), '10.0.0.0/24')
  assertEquals(parseOptionalCidrField(c, {}), null)

  const patchFields = { updatedAt: '2020-01-01T00:00:00.000Z' }
  assertEquals(applyCidrPatch(c, { cidr: null }, patchFields), null)
  assertEquals(patchFields.cidr, null)
})

test('requireDockerNetworkOptions enforces dockerNetworkName', async () => {
  const c = mockContext()
  const ok = requireDockerNetworkOptions(c, { dockerNetworkName: 'shared-net' })
  assertEquals(ok, { dockerNetworkName: 'shared-net' })
  const bad = requireDockerNetworkOptions(c, {})
  if (!(bad instanceof Response)) throw new TypeError('expected response')
  assertEquals(bad.status, 400)
  assertEquals(await bad.json(), { error: 'docker_network_name_required' })
})

test('parseNetworkPatchFields normalizes docker options on patch', async () => {
  const c = mockContext()
  const dockerPatch = parseNetworkPatchFields(c, {
    options: { dockerNetworkName: 'external-net' },
  }, 'docker')
  if (dockerPatch instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(dockerPatch.options, { dockerNetworkName: 'external-net' })

  const datacenterPatch = parseNetworkPatchFields(c, {
    options: { note: 'site lan' },
  }, 'datacenter')
  if (datacenterPatch instanceof Response) throw new TypeError('expected patch fields')
  assertEquals(datacenterPatch.options, { note: 'site lan' })
})

test('rejectImmutableNetworkScopePatch blocks datacenterId and serverId on patch', async () => {
  const c = mockContext()
  assertEquals(rejectImmutableNetworkScopePatch(c, {}), null)
  const denied = rejectImmutableNetworkScopePatch(c, { serverId: '550e8400-e29b-41d4-a716-446655440000' })
  if (!(denied instanceof Response)) throw new TypeError('expected response')
  assertEquals(denied.status, 400)
})
