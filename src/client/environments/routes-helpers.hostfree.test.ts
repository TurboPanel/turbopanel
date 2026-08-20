/**
 * Host-free coverage for environment route pure validation helpers.
 */

import { assertEquals } from '@std/assert'
import { emptyComposeDocument } from '../../lib/compose/index.ts'
import {
  parseCreateEnvironmentJsonb,
  parseCreateEnvironmentNames,
  parseEnvironmentPatchMetadata,
  parseEnvironmentPatchOptions,
  parseJsonbField,
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
      name: 'Production',
      description: null,
      projectId: validUuid,
      serverId: null,
      metadata: null,
      options: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).name,
    'Production',
  )
})

test('parseCreateEnvironmentNames validates names', () => {
  const ok = parseCreateEnvironmentNames({ name: 'Staging' })
  if (!ok.ok) throw new TypeError('expected valid environment names')
  assertEquals(ok.name, 'Staging')
  assertEquals(parseCreateEnvironmentNames({ name: 'bad/name' }).ok, true)
  assertEquals(parseCreateEnvironmentNames({ name: 'bad\nname' }).ok, false)
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
  const omitted = parseOptionalServerIdShape({})
  if (!omitted.ok) throw new TypeError('expected omitted serverId')
  assertEquals(omitted.serverId, undefined)

  const cleared = parseOptionalServerIdShape({ serverId: null })
  if (!cleared.ok) throw new TypeError('expected null serverId')
  assertEquals(cleared.serverId, null)

  assertEquals(parseOptionalServerIdShape({ serverId: 'bad' }).ok, false)

  const pinned = parseOptionalServerIdShape({ serverId: validUuid })
  if (!pinned.ok) throw new TypeError('expected valid serverId')
  assertEquals(pinned.serverId, validUuid)
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

test('parseCreateEnvironmentNames rejects bad description and reads name', () => {
  assertEquals(
    parseCreateEnvironmentNames({ name: 'Ok', description: 12 }).ok,
    false,
  )
  const named = parseCreateEnvironmentNames({ name: 'Prod', description: 'live' })
  if (!named.ok) throw new TypeError('expected valid name create')
  assertEquals(named.name, 'Prod')
  assertEquals(named.description, 'live')
})

test('parseCreateEnvironmentJsonb rejects invalid metadata and compose', () => {
  assertEquals(parseCreateEnvironmentJsonb({ metadata: [] }).ok, false)

  const badCompose = parseCreateEnvironmentJsonb({
    options: { compose: { services: { web: { imaage: 'nginx' } } } },
  })
  assertEquals(badCompose.ok, false)
  if (badCompose.ok) throw new TypeError('expected compose_invalid')
  assertEquals(badCompose.error, 'compose_invalid')
})

test('parseEnvironmentPatchMetadata strips promoted keys when present', () => {
  const parsed = parseEnvironmentPatchMetadata({
    metadata: { serverId: validUuid, component: 'x', label: 'keep' },
  })
  if (!parsed.ok) throw new TypeError('expected valid metadata patch')
  assertEquals(parsed.metadata, { label: 'keep' })

  assertEquals(parseEnvironmentPatchMetadata({ metadata: [] }).ok, false)
})

test('parseEnvironmentPatchOptions accepts valid compose overlays', () => {
  const compose = emptyComposeDocument()
  compose.data.services = {
    api: { image: 'nginx:alpine' },
  }
  const parsed = parseEnvironmentPatchOptions({ options: { compose } })
  if (!parsed.ok) throw new TypeError('expected valid options patch')
  assertEquals(parsed.options === 'absent', false)
})

test('parseJsonbField distinguishes absent null and invalid shapes', () => {
  assertEquals(parseJsonbField({}, 'metadata'), null)
  assertEquals(parseJsonbField({ metadata: { a: 1 } }, 'metadata'), { a: 1 })
  assertEquals(parseJsonbField({ metadata: [] }, 'metadata'), 'invalid')
})
