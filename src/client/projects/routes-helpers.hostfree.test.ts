/**
 * Host-free coverage for project route pure validation helpers.
 */

import { assertEquals } from '@std/assert'
import {
  assertDefaultServerIdShape,
  catalogProjectOptions,
  mapCreateProjectError,
  normalizeProjectPatchOptions,
  parseConfigureProjectBody,
  parseCreateProjectMetadata,
  parseCreateProjectNames,
  parseCreateProjectOptions,
  parseCreateProjectServerIdField,
  parseProjectPatchOptionsBody,
  resolveCatalogEntryForCreate,
  resolveCreateProjectType,
} from './routes-helpers.ts'
import type { CatalogEntry } from './catalog/index.ts'
import { emptyComposeDocument, type ComposeDocument } from '../../lib/compose/index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const validUuid = '11111111-1111-4111-8111-111111111111'

test('resolveCreateProjectType rejects missing and invalid types', () => {
  assertEquals(resolveCreateProjectType({}), 'invalid')
  assertEquals(resolveCreateProjectType({ type: '' }), 'invalid')
  assertEquals(resolveCreateProjectType({ type: 'not-a-type' }), 'invalid')
  assertEquals(resolveCreateProjectType({ type: 'empty' }), 'empty')
  assertEquals(resolveCreateProjectType({ type: 'docker-compose' }), 'docker-compose')
})

test('resolveCatalogEntryForCreate handles template and managed codes', () => {
  assertEquals(resolveCatalogEntryForCreate('docker-compose', {}), undefined)
  assertEquals(resolveCatalogEntryForCreate('template', {}), 'missing_code')
  assertEquals(resolveCatalogEntryForCreate('template', { code: 'unknown-entry' }), 'unknown_code')

  const managed = resolveCatalogEntryForCreate('managed', { code: 'postgres' })
  if (managed === 'missing_code' || managed === 'unknown_code' || managed === undefined) {
    throw new TypeError('expected managed postgres catalog entry')
  }
  assertEquals(managed.kind, 'managed')
})

test('mapCreateProjectError maps encryption failures only', () => {
  assertEquals(mapCreateProjectError(null), null)
  assertEquals(mapCreateProjectError(new Error('other')), null)
  assertEquals(
    mapCreateProjectError(new Error('encryption unavailable')),
    { error: 'Encryption unavailable', status: 503 },
  )
})

test('catalogProjectOptions prefers caller options and engine defaults', () => {
  const entry = {
    code: 'postgres',
    kind: 'managed',
    displayName: 'PostgreSQL',
    description: 'Managed PostgreSQL',
    compose: emptyComposeDocument(),
    options: { managedEngine: 'postgres' },
    environments: [],
  } satisfies CatalogEntry

  assertEquals(
    catalogProjectOptions({ options: { compose: { services: { web: {} } } }, entry }, true),
    { compose: { services: { web: {} } } },
  )
  assertEquals(
    catalogProjectOptions({ options: null, entry }, true).managedEngine,
    'postgres',
  )
  assertEquals(
    catalogProjectOptions({ options: null, entry }, false),
    { compose: entry.compose },
  )
})

test('parseCreateProjectNames validates display names', () => {
  const ok = parseCreateProjectNames({ name: 'My Project', description: 'Notes' })
  if (!ok.ok) throw new TypeError('expected valid names')
  assertEquals(ok.name, 'My Project')
  assertEquals(ok.description, 'Notes')

  assertEquals(parseCreateProjectNames({ name: 'bad@name' }).ok, true)
  assertEquals(parseCreateProjectNames({ name: 'bad\nname' }).ok, false)
})

test('parseCreateProjectOptions accepts valid compose documents', () => {
  assertEquals(parseCreateProjectOptions({ options: [] }).ok, false)

  const compose = emptyComposeDocument()
  compose.data.services = {
    web: { image: 'nginx:alpine' },
  }

  const parsed = parseCreateProjectOptions({ options: { compose } })
  if (!parsed.ok) throw new TypeError('expected valid compose options')
  const services = (parsed.options?.compose as ComposeDocument).data
    .services as Record<string, { image?: string }>
  assertEquals(services.web?.image, 'nginx:alpine')
})

test('parseCreateProjectMetadata strips reserved component key', () => {
  const parsed = parseCreateProjectMetadata({
    metadata: { component: 'hosting-ingress', note: 'keep' },
  })
  if (!parsed.ok) throw new TypeError('expected valid metadata')
  assertEquals(parsed.metadata?.component, undefined)
  assertEquals(parsed.metadata?.note, 'keep')
})

test('parseCreateProjectServerIdField accepts omitted, null, and uuid', () => {
  const omitted = parseCreateProjectServerIdField({})
  assertEquals(omitted.ok, true)
  if (!omitted.ok) throw new TypeError()
  assertEquals(omitted.serverId, undefined)

  const cleared = parseCreateProjectServerIdField({ serverId: null })
  if (!cleared.ok) throw new TypeError('expected null serverId')
  assertEquals(cleared.serverId, null)

  assertEquals(parseCreateProjectServerIdField({ serverId: '' }).ok, false)
  const pinned = parseCreateProjectServerIdField({ serverId: validUuid })
  if (!pinned.ok) throw new TypeError('expected uuid serverId')
  assertEquals(pinned.serverId, validUuid)
})

test('normalizeProjectPatchOptions validates containerNaming and defaultServerId', () => {
  const compose = emptyComposeDocument()
  compose.data.services = {
    web: { image: 'nginx:alpine' },
  }

  const badNaming = normalizeProjectPatchOptions({
    compose,
    containerNaming: 'rename-everything',
  })
  assertEquals(badNaming.ok, false)

  const normalized = normalizeProjectPatchOptions({
    compose,
    containerNaming: 'custom',
    defaultServerId: null,
  })
  if (!normalized.ok) throw new TypeError('expected normalized options')
  assertEquals(normalized.options.containerNaming, 'custom')
  assertEquals('defaultServerId' in normalized.options, false)
})

test('parseProjectPatchOptionsBody returns null when options omitted', () => {
  const absent = parseProjectPatchOptionsBody({})
  if (!absent.ok) throw new TypeError('expected absent options')
  assertEquals(absent.options, null)
})

test('assertDefaultServerIdShape rejects malformed server ids', () => {
  assertEquals(assertDefaultServerIdShape(undefined), null)
  assertEquals(assertDefaultServerIdShape({ defaultServerId: null }), null)
  assertEquals(assertDefaultServerIdShape({ defaultServerId: 'not-a-uuid' })?.error, 'Invalid request')
  assertEquals(assertDefaultServerIdShape({ defaultServerId: validUuid }), null)
})

test('parseConfigureProjectBody requires catalog codes for template and managed', () => {
  assertEquals(parseConfigureProjectBody({ type: 'docker-compose' }).ok, true)
  assertEquals(parseConfigureProjectBody({ type: 'template' }).ok, false)
  const managed = parseConfigureProjectBody({ type: 'managed', code: 'postgres' })
  if (!managed.ok) throw new TypeError('expected managed configure body')
  assertEquals(managed.projectType, 'managed')
  assertEquals(managed.catalogCode, 'postgres')
})
