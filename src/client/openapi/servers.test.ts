import { assertEquals } from '@std/assert'
import {
  SERVER_DELETE_BLOCKER_KIND_VALUES,
  SERVER_SERVICES_REMOVAL_KIND_VALUES,
} from '../servers/delete-guards.ts'
import { serverSchemas } from './servers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('ServerDeleteBlocker kind enum covers forgettable leftovers and remaining RESTRICT FKs', () => {
  const schema = serverSchemas.ServerDeleteBlocker as {
    required: string[]
    properties: {
      kind: { enum: string[] }
    }
  }
  assertEquals(schema.required, ['kind', 'count', 'label'])
  assertEquals(schema.properties.kind.enum, [
    'network',
    'container',
    'ip',
    'environment',
    'managed',
    'replica',
    'deployment',
    'slot',
    'copy',
  ])
})

test('ServerServicesRemovalReason kind enum matches delete blockers plus colocated', () => {
  const schema = serverSchemas.ServerServicesRemovalReason as {
    properties: {
      kind: { enum: string[] }
    }
  }
  assertEquals(schema.properties.kind.enum, [...SERVER_DELETE_BLOCKER_KIND_VALUES, 'colocated'])
  assertEquals(schema.properties.kind.enum, [...SERVER_SERVICES_REMOVAL_KIND_VALUES])
  assertEquals(schema.properties.kind.enum.includes('backup'), false)
})

test('ServerDeletePreview requires the Host-is-gone lists', () => {
  const schema = serverSchemas.ServerDeletePreview as { required: string[] }
  assertEquals(schema.required, [
    'online',
    'canForget',
    'colocated',
    'blockers',
    'containers',
    'networks',
    'ips',
    'environments',
    'members',
    'blockedDatabases',
  ])
})

test('ServerDeleteBlocker can name the rows behind the count', () => {
  const schema = serverSchemas.ServerDeleteBlocker as {
    required: string[]
    properties: Record<string, { items?: { $ref?: string } }>
  }
  assertEquals(schema.required.includes('items'), false)
  assertEquals(schema.properties.items?.items?.$ref, '#/components/schemas/ServerDeleteBlockerItem')
  const environmentItem = serverSchemas.ServerBlockerEnvironmentItem as { required: string[] }
  assertEquals(environmentItem.required, ['id', 'name', 'projectId', 'projectName', 'hasDatabase'])
  const databaseItem = serverSchemas.ServerBlockerDatabaseItem as { required: string[] }
  assertEquals(databaseItem.required, ['id', 'name'])
})

test('ServerServicesRemovalReason carries the same named items', () => {
  const schema = serverSchemas.ServerServicesRemovalReason as {
    required: string[]
    properties: Record<string, { items?: { $ref?: string } }>
  }
  assertEquals(schema.required, ['kind', 'count', 'message'])
  assertEquals(schema.properties.items?.items?.$ref, '#/components/schemas/ServerDeleteBlockerItem')
})

test('ServerServicesResponse documents the attached-services snapshot', () => {
  const schema = serverSchemas.ServerServicesResponse as {
    required: string[]
    properties: {
      removal: { required: string[] }
      hostServices?: unknown
    }
  }
  assertEquals(schema.required, [
    'serverId',
    'removal',
    'apps',
    'databases',
    'databaseUsers',
    'backups',
    'networks',
    'ipCount',
    'runtimes',
  ])
  assertEquals(schema.properties.removal.required, ['canRemove', 'online', 'canForget', 'reasons'])
  assertEquals(schema.properties.hostServices, undefined)
})

test('ServerRow documents tierPlacement against ServerTierPlacement', () => {
  const row = serverSchemas.ServerRow as {
    properties: {
      tierPlacement: { oneOf: Array<{ $ref?: string; type?: string }> }
    }
  }
  const placement = serverSchemas.ServerTierPlacement as {
    required: string[]
  }
  assertEquals(placement.required, ['licenseTier', 'requiredTier', 'recommendedTier', 'unwatched'])
  assertEquals(
    row.properties.tierPlacement.oneOf.some(
      (entry) => entry.$ref === '#/components/schemas/ServerTierPlacement'
    ),
    true
  )
})
