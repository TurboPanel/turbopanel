/**
 * Host-free coverage for service route pure validation helpers.
 */

import { assertEquals } from 'jsr:@std/assert'
import {
  parseServiceCreateFields,
  parseServicePatchFields,
  rejectComposeServiceNameInBody,
  serializeService,
  SERVICE_CREATE_NOT_SUPPORTED,
  stripServicePromotedMetadata,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const validUuid = '11111111-1111-4111-8111-111111111111'

test('serializeService exposes composeServiceName', () => {
  assertEquals(
    serializeService({
      id: validUuid,
      displayName: 'Web',
      description: null,
      environmentId: validUuid,
      composeServiceName: 'web',
      metadata: null,
      options: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).composeServiceName,
    'web',
  )
})

test('rejectComposeServiceNameInBody blocks direct compose name writes', () => {
  assertEquals(rejectComposeServiceNameInBody({}), null)
  const rejected = rejectComposeServiceNameInBody({ composeServiceName: 'web' })
  if (!rejected) throw new TypeError('expected compose name rejection')
  assertEquals(rejected.error, 'compose_service_name_read_only')
})

test('stripServicePromotedMetadata removes composeServiceName', () => {
  assertEquals(
    stripServicePromotedMetadata({ composeServiceName: 'web', note: 1 }),
    { note: 1 },
  )
})

test('parseServiceCreateFields rejects invalid options and compose name', () => {
  const composeRejected = parseServiceCreateFields({ composeServiceName: 'web' })
  if (!composeRejected.ok) {
    assertEquals(composeRejected.error, 'compose_service_name_read_only')
  } else {
    throw new TypeError('expected compose name rejection')
  }

  const invalidOptions = parseServiceCreateFields({
    options: [],
  })
  assertEquals(invalidOptions.ok, false)
  if (invalidOptions.ok) throw new TypeError()
  assertEquals(invalidOptions.error, 'invalid_service_options')
})

test('parseServicePatchFields normalizes metadata and options', () => {
  const parsed = parseServicePatchFields({
    name: 'API',
    metadata: { composeServiceName: 'api', label: 'keep' },
    options: { instances: 2 },
  })
  if (!parsed.ok) throw new TypeError('expected valid service patch')
  assertEquals(parsed.patch.metadata?.composeServiceName, undefined)
  assertEquals(parsed.patch.options?.instances, 2)
})

test('parseServiceCreateFields accepts display metadata and options', () => {
  const parsed = parseServiceCreateFields({
    displayName: 'API',
    description: 'edge',
    metadata: { composeServiceName: 'drop', note: 1 },
    options: { instances: 2 },
  })
  if (!parsed.ok) throw new TypeError('expected valid service create')
  assertEquals(parsed.displayName, 'API')
  assertEquals(parsed.description, 'edge')
  assertEquals(parsed.metadata?.composeServiceName, undefined)
  assertEquals(parsed.metadata?.note, 1)
  assertEquals(parsed.options?.instances, 2)
})

test('parseServicePatchFields rejects compose name and invalid options', () => {
  const composeRejected = parseServicePatchFields({ composeServiceName: 'web' })
  if (!composeRejected.ok) {
    assertEquals(composeRejected.error, 'compose_service_name_read_only')
  } else {
    throw new TypeError('expected compose name rejection')
  }

  const invalidOptions = parseServicePatchFields({ options: 'bad' })
  assertEquals(invalidOptions.ok, false)
  if (invalidOptions.ok) throw new TypeError()
  assertEquals(invalidOptions.error, 'invalid_service_options')
})
