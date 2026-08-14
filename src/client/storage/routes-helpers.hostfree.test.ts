/**
 * Host-free coverage for storage location/mount patch helpers (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  isAccessMode,
  isApiLocationProvider,
  isLocationRole,
  isLocationState,
  isRetention,
  parseCreateMountFields,
  parseLocationPatchFields,
  parseMountPatchFields,
} from './routes-helpers.ts'

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

async function expectInvalidRequest(response: unknown): Promise<void> {
  if (!(response instanceof Response)) {
    throw new TypeError('expected error response')
  }
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'Invalid request' })
}

test('storage enum guards accept known values only', () => {
  assertEquals(isAccessMode('multi_reader'), true)
  assertEquals(isAccessMode('shared'), false)
  assertEquals(isRetention('delete'), true)
  assertEquals(isRetention('keep'), false)
  assertEquals(isApiLocationProvider('docker'), true)
  assertEquals(isApiLocationProvider('s3'), false)
  assertEquals(isLocationRole('replica'), true)
  assertEquals(isLocationRole('leader'), false)
  assertEquals(isLocationState('ready'), true)
  assertEquals(isLocationState('online'), false)
})

test('parseLocationPatchFields copies known fields and rejects bad jsonb', async () => {
  const c = mockContext()
  await expectInvalidRequest(parseLocationPatchFields(c, { metadata: [] }))

  const fields = parseLocationPatchFields(c, {
    provider: 'path',
    serverId: 'srv-1',
    path: '/data',
    endpoint: null,
    role: 'replica',
    state: 'ready',
    credentialId: null,
    options: { tier: 'fast' },
  })
  if (fields instanceof Response) {
    throw new TypeError('expected location patch fields')
  }
  assertEquals(fields.provider, 'path')
  assertEquals(fields.serverId, 'srv-1')
  assertEquals(fields.path, '/data')
  assertEquals(fields.endpoint, null)
  assertEquals(fields.role, 'replica')
  assertEquals(fields.state, 'ready')
  assertEquals(fields.credentialId, null)
  assertEquals(fields.options, { tier: 'fast' })
  assertEquals(typeof fields.updatedAt, 'string')
})

test('parseMountPatchFields rejects blank destinationPath and bad readOnly', async () => {
  const c = mockContext()
  const blank = parseMountPatchFields(c, { destinationPath: '   ' })
  if (!(blank instanceof Response)) {
    throw new TypeError('expected blank destinationPath response')
  }
  assertEquals(blank.status, 400)
  assertEquals(await blank.json(), { error: 'destinationPath is required' })
  await expectInvalidRequest(parseMountPatchFields(c, { readOnly: 'yes' }))

  const fields = parseMountPatchFields(c, {
    destinationPath: '/var/lib/data',
    subpath: null,
    readOnly: true,
    metadata: { note: 1 },
  })
  if (fields instanceof Response) {
    throw new TypeError('expected mount patch fields')
  }
  assertEquals(fields.destinationPath, '/var/lib/data')
  assertEquals(fields.subpath, null)
  assertEquals(fields.readOnly, true)
  assertEquals(fields.metadata, { note: 1 })
})

test('parseCreateMountFields requires destinationPath and serviceId', async () => {
  const c = mockContext()
  await expectInvalidRequest(
    parseCreateMountFields(c, { mount: { serviceId: 'svc-1' } }),
  )
  const blank = parseCreateMountFields(c, {
    mount: { serviceId: 'svc-1', destinationPath: '  ' },
  })
  if (!(blank instanceof Response)) {
    throw new TypeError('expected blank destinationPath response')
  }
  assertEquals(blank.status, 400)
  assertEquals(await blank.json(), { error: 'destinationPath is required' })
  assertEquals(parseCreateMountFields(c, {}), undefined)
  await expectInvalidRequest(parseCreateMountFields(c, { mount: 'bad' }))
})
