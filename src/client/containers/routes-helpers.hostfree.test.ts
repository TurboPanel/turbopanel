/**
 * Host-free coverage for container route pure validation helpers.
 */

import { assertEquals } from '@std/assert'
import {
  parseCreateContainerFields,
  parsePatchContainerFields,
  readOptionalPositiveInt,
  readOptionalTopLevelString,
  serializeContainer,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const validUuid = '11111111-1111-4111-8111-111111111111'
const environmentUuid = '22222222-2222-4222-8222-222222222222'

test('serializeContainer exposes role, ordinal, and the joined environment', () => {
  const serialized = serializeContainer({
    id: validUuid,
    serviceId: validUuid,
    environmentId: environmentUuid,
    serverId: validUuid,
    containerId: 'docker-id',
    containerName: 'c1',
    status: 'running',
    role: 'service',
    composeServiceName: 'web',
    ordinal: 2,
    metadata: null,
    options: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  assertEquals(serialized.ordinal, 2)
  // Clients group a project-wide list by this without a call per environment.
  assertEquals(serialized.environmentId, environmentUuid)
})

test('readOptionalPositiveInt floors and rejects non-positive values', () => {
  assertEquals(readOptionalPositiveInt({ ordinal: 2.9 }, 'ordinal'), 2)
  assertEquals(readOptionalPositiveInt({ ordinal: 0 }, 'ordinal'), undefined)
  assertEquals(readOptionalPositiveInt({ ordinal: '1' }, 'ordinal'), undefined)
})

test('readOptionalTopLevelString ignores blank strings', () => {
  assertEquals(readOptionalTopLevelString({ status: 'running' }, 'status'), 'running')
  assertEquals(readOptionalTopLevelString({ status: '' }, 'status'), undefined)
})

test('parseCreateContainerFields requires core identity fields', () => {
  assertEquals(parseCreateContainerFields({}).ok, false)

  const parsed = parseCreateContainerFields({
    serviceId: validUuid,
    serverId: validUuid,
    containerId: 'docker-id',
    containerName: 'c1',
    status: 'running',
    composeServiceName: 'web',
    ordinal: 3,
    metadata: { status: 'running', note: 'keep' },
  })
  if (!parsed.ok) throw new TypeError('expected valid create fields')
  assertEquals(parsed.fields.ordinal, 3)
  assertEquals(parsed.fields.metadata?.status, undefined)
  assertEquals(parsed.fields.metadata?.note, 'keep')
})

test('parsePatchContainerFields strips promoted metadata keys', () => {
  const parsed = parsePatchContainerFields({
    metadata: { containerId: 'docker-id', note: 'keep' },
    status: 'stopped',
  })
  if (!parsed.ok) throw new TypeError('expected valid patch fields')
  assertEquals(parsed.patch.metadata?.containerId, undefined)
  assertEquals(parsed.patch.status, 'stopped')
})

test('parseCreateContainerFields rejects invalid jsonb and missing identity fields', () => {
  const missingServer = parseCreateContainerFields({
    serviceId: validUuid,
    containerId: 'docker-id',
    containerName: 'c1',
    status: 'running',
    composeServiceName: 'web',
  })
  assertEquals(missingServer.ok, false)

  const badMetadata = parseCreateContainerFields({
    serviceId: validUuid,
    serverId: validUuid,
    containerId: 'docker-id',
    containerName: 'c1',
    status: 'running',
    composeServiceName: 'web',
    metadata: [],
  })
  assertEquals(badMetadata.ok, false)
  if (badMetadata.ok) throw new TypeError('expected invalid metadata')
  assertEquals(badMetadata.field, 'metadata')

  const badOptions = parseCreateContainerFields({
    serviceId: validUuid,
    serverId: validUuid,
    containerId: 'docker-id',
    containerName: 'c1',
    status: 'running',
    composeServiceName: 'web',
    options: 'nope',
  })
  assertEquals(badOptions.ok, false)
  if (badOptions.ok) throw new TypeError('expected invalid options')
  assertEquals(badOptions.field, 'options')
})

test('parsePatchContainerFields rejects invalid name metadata and options', () => {
  assertEquals(parsePatchContainerFields({ name: 12 }).ok, false)

  const badMetadata = parsePatchContainerFields({ metadata: [] })
  assertEquals(badMetadata.ok, false)
  if (badMetadata.ok) throw new TypeError('expected invalid metadata')
  assertEquals(badMetadata.field, 'metadata')

  const badOptions = parsePatchContainerFields({ options: 'nope' })
  assertEquals(badOptions.ok, false)
  if (badOptions.ok) throw new TypeError('expected invalid options')
  assertEquals(badOptions.field, 'options')

  const withOptions = parsePatchContainerFields({
    options: { note: 'keep' },
    containerId: 'docker-id',
    containerName: 'renamed',
    composeServiceName: 'api',
  })
  if (!withOptions.ok) throw new TypeError('expected valid patch fields')
  assertEquals(withOptions.patch.options, { note: 'keep' })
  assertEquals(withOptions.patch.containerId, 'docker-id')
  assertEquals(withOptions.patch.containerName, 'renamed')
  assertEquals(withOptions.patch.composeServiceName, 'api')
})
