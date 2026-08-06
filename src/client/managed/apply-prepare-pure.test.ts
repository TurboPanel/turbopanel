import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { ManagedApplyCommandPayload } from '../../lib/commands/schemas.ts'
import {
  isPrepareError,
  mapManagedApplyPrepareError,
  prepareErrorResponse,
  type ManagedApplyPrepareError,
} from './apply-prepare.ts'

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

function assertPayloadShape(value: unknown): asserts value is ManagedApplyCommandPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected ManagedApplyCommandPayload object')
  }
  if (!('managedId' in value) || typeof value.managedId !== 'string') {
    throw new TypeError('expected managedId string on payload')
  }
  if ('kind' in value) {
    throw new TypeError('payload must not carry prepare-error kind')
  }
}

function minimalPayload(
  overrides: Partial<ManagedApplyCommandPayload> = {},
): ManagedApplyCommandPayload {
  return {
    managedId: 'm1',
    environmentId: 'e1',
    engine: 'postgres',
    projectName: 'turbopanel-managed-m1',
    containerName: 'svc-1',
    image: 'postgres:18',
    containerPort: 5432,
    composeYaml: 'services: {}',
    configFiles: [],
    volumes: [],
    exposure: { enabled: false, protocol: 'tcp' },
    credentials: [],
    ...overrides,
  } as ManagedApplyCommandPayload
}

const ALL_PREPARE_ERRORS: Array<{
  error: ManagedApplyPrepareError
  status: number
  body: string
}> = [
  {
    error: { kind: 'datacenter_ip_required', serverId: 's1' },
    status: 422,
    body: 'datacenter_ip_required',
  },
  {
    error: { kind: 'daemon_key_unavailable', serverId: 's1' },
    status: 422,
    body: 'daemon_key_unavailable',
  },
  {
    error: { kind: 'managed_credential_not_sealed' },
    status: 500,
    body: 'managed_credential_not_sealed',
  },
  {
    error: { kind: 'managed_settings_invalid' },
    status: 400,
    body: 'managed_settings_invalid',
  },
]

test('isPrepareError is true for every ManagedApplyPrepareError kind', () => {
  for (const { error } of ALL_PREPARE_ERRORS) {
    assertEquals(isPrepareError(error), true)
  }
})

test('isPrepareError is false for command payloads without kind', () => {
  const payload = minimalPayload()
  assertPayloadShape(payload)
  assertEquals(isPrepareError(payload), false)

  const withExtras = minimalPayload({
    databases: [{ name: 'app', action: 'create' }],
    dropUsers: ['u1'],
    resources: { cpus: 1 },
  })
  assertPayloadShape(withExtras)
  assertEquals(isPrepareError(withExtras), false)
})

test('isPrepareError treats any kind-bearing object as prepare error', () => {
  // Discriminator is structural (`'kind' in value`) — payloads never carry kind.
  const tagged = { kind: 'datacenter_ip_required', serverId: 's2' }
  assertEquals(isPrepareError(tagged as ManagedApplyPrepareError), true)

  const sealedOnly: ManagedApplyPrepareError = {
    kind: 'managed_credential_not_sealed',
  }
  assertEquals(isPrepareError(sealedOnly), true)
})

test('isPrepareError distinguishes error kinds from payloads', () => {
  const error: ManagedApplyPrepareError = {
    kind: 'managed_settings_invalid',
  }
  assertEquals(isPrepareError(error), true)

  const payload = minimalPayload()
  assertEquals(isPrepareError(payload), false)
})

test('prepareErrorResponse maps every ManagedApplyPrepareError kind', async () => {
  const c = mockContext()

  for (const { error, status, body } of ALL_PREPARE_ERRORS) {
    const response = prepareErrorResponse(c, error)
    assertEquals(response.status, status)
    const json: unknown = await response.json()
    if (typeof json !== 'object' || json === null || !('error' in json)) {
      throw new TypeError('expected { error } JSON body')
    }
    assertEquals(json, { error: body })
  }
})

test('prepareErrorResponse status codes stay stable per kind', async () => {
  const c = mockContext()

  const datacenter = prepareErrorResponse(c, {
    kind: 'datacenter_ip_required',
    serverId: 'srv-a',
  })
  assertEquals(datacenter.status, 422)
  assertEquals(await datacenter.json(), { error: 'datacenter_ip_required' })

  const daemonKey = prepareErrorResponse(c, {
    kind: 'daemon_key_unavailable',
    serverId: 'srv-b',
  })
  assertEquals(daemonKey.status, 422)
  assertEquals(await daemonKey.json(), { error: 'daemon_key_unavailable' })

  const credential = prepareErrorResponse(c, {
    kind: 'managed_credential_not_sealed',
  })
  assertEquals(credential.status, 500)
  assertEquals(await credential.json(), { error: 'managed_credential_not_sealed' })

  const settings = prepareErrorResponse(c, {
    kind: 'managed_settings_invalid',
  })
  assertEquals(settings.status, 400)
  assertEquals(await settings.json(), { error: 'managed_settings_invalid' })
})

test('mapManagedApplyPrepareError delegates to prepareErrorResponse for every kind', async () => {
  const c = mockContext()

  for (const { error, status, body } of ALL_PREPARE_ERRORS) {
    const viaMap = mapManagedApplyPrepareError(c, error)
    const viaPrepare = prepareErrorResponse(c, error)
    assertEquals(viaMap.status, status)
    assertEquals(viaMap.status, viaPrepare.status)
    assertEquals(await viaMap.json(), { error: body })
  }
})

test('mapManagedApplyPrepareError matches prepareErrorResponse body and status', async () => {
  const c = mockContext()
  const error: ManagedApplyPrepareError = {
    kind: 'daemon_key_unavailable',
    serverId: 's-match',
  }
  const mapped = mapManagedApplyPrepareError(c, error)
  const prepared = prepareErrorResponse(c, error)
  assertEquals(mapped.status, prepared.status)
  assertEquals(await mapped.json(), await prepared.json())
})

test('mapManagedApplyPrepareError returns 400 for managed_settings_invalid', async () => {
  const c = mockContext()
  const response = mapManagedApplyPrepareError(c, {
    kind: 'managed_settings_invalid',
  })
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'managed_settings_invalid' })
})

test('prepareErrorResponse ignores serverId on wire body', async () => {
  const c = mockContext()
  const response = prepareErrorResponse(c, {
    kind: 'datacenter_ip_required',
    serverId: 'should-not-leak',
  })
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new TypeError('expected JSON object body')
  }
  assertEquals(Object.keys(body).sort((a, b) => a.localeCompare(b)), ['error'])
  assertEquals(body, { error: 'datacenter_ip_required' })
})
