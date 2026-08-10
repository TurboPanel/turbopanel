/**
 * Host-free coverage for container route pure validation helpers.
 */

import { assertEquals } from 'jsr:@std/assert'
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

test('serializeContainer exposes role and ordinal', () => {
  assertEquals(
    serializeContainer({
      id: validUuid,
      serviceId: validUuid,
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
    }).ordinal,
    2,
  )
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
