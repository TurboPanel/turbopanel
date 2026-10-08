import { assertEquals } from '@std/assert'
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

test('ServerServicesResponse documents the attached-services snapshot', () => {
  const schema = serverSchemas.ServerServicesResponse as {
    required: string[]
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
    'hostServices',
    'runtimes',
  ])
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
