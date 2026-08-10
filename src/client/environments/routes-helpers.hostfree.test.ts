/**
 * Host-free coverage for environment route pure validation helpers.
 */

import { assertEquals } from 'jsr:@std/assert'
import { emptyComposeDocument } from '../../lib/compose/index.ts'
import {
  parseCreateEnvironmentJsonb,
  parseCreateEnvironmentNames,
  parseEnvironmentPatchMetadata,
  parseEnvironmentPatchOptions,
  parseOptionalServerIdShape,
  serializeEnvironment,
  stripEnvironmentPromotedMetadata,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const validUuid = '11111111-1111-4111-8111-111111111111'

test('serializeEnvironment maps row fields', () => {
  assertEquals(
    serializeEnvironment({
      id: validUuid,
      displayName: 'Production',
      description: null,
      projectId: validUuid,
      serverId: null,
      metadata: null,
      options: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).displayName,
    'Production',
  )
})

test('parseCreateEnvironmentNames validates names', () => {
  const ok = parseCreateEnvironmentNames({ name: 'Staging' })
  if (!ok.ok) throw new TypeError('expected valid environment names')
  assertEquals(ok.displayName, 'Staging')
  assertEquals(parseCreateEnvironmentNames({ name: 'bad/name' }).ok, false)
})

test('stripEnvironmentPromotedMetadata removes serverId and component', () => {
  assertEquals(
    stripEnvironmentPromotedMetadata({ serverId: validUuid, component: 'x', note: 1 }),
    { note: 1 },
  )
})

test('parseCreateEnvironmentJsonb lints compose and strips promoted metadata', () => {
  assertEquals(parseCreateEnvironmentJsonb({ options: [] }).ok, false)

  const compose = emptyComposeDocument()
  compose.data.services = {
    web: { image: 'nginx:alpine' },
  }

  const parsed = parseCreateEnvironmentJsonb({
    options: { compose },
    metadata: { serverId: validUuid, label: 'env' },
  })
  if (!parsed.ok) throw new TypeError('expected valid environment jsonb')
  assertEquals(parsed.metadata?.serverId, undefined)
  assertEquals(parsed.metadata?.label, 'env')
})

test('parseOptionalServerIdShape accepts omitted, null, and uuid', () => {
  assertEquals(parseOptionalServerIdShape({}).serverId, 'omitted')
  assertEquals(parseOptionalServerIdShape({ serverId: null }).serverId, null)
  assertEquals(parseOptionalServerIdShape({ serverId: 'bad' }).ok, false)
  assertEquals(parseOptionalServerIdShape({ serverId: validUuid }).serverId, validUuid)
})

test('parseEnvironmentPatchMetadata returns absent when field omitted', () => {
  const absent = parseEnvironmentPatchMetadata({})
  if (!absent.ok) throw new TypeError('expected absent metadata')
  assertEquals(absent.metadata, 'absent')
})

test('parseEnvironmentPatchOptions rejects invalid compose', () => {
  const invalid = parseEnvironmentPatchOptions({ options: 'bad' })
  assertEquals(invalid.ok, false)

  const absent = parseEnvironmentPatchOptions({})
  if (!absent.ok) throw new TypeError('expected absent options')
  assertEquals(absent.options, 'absent')
})
