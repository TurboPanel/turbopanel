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

test('isPrepareError distinguishes error kinds from payloads', () => {
  const error: ManagedApplyPrepareError = {
    kind: 'managed_settings_invalid',
  }
  assertEquals(isPrepareError(error), true)

  const payload = {
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
  } as ManagedApplyCommandPayload
  assertEquals(isPrepareError(payload), false)
})

test('prepareErrorResponse maps every ManagedApplyPrepareError kind', async () => {
  const c = mockContext()
  const cases: Array<{ error: ManagedApplyPrepareError; status: number; body: string }> = [
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

  for (const { error, status, body } of cases) {
    const response = prepareErrorResponse(c, error)
    assertEquals(response.status, status)
    assertEquals(await response.json(), { error: body })
  }
})

test('mapManagedApplyPrepareError delegates to prepareErrorResponse', async () => {
  const c = mockContext()
  const response = mapManagedApplyPrepareError(c, {
    kind: 'managed_settings_invalid',
  })
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'managed_settings_invalid' })
})
