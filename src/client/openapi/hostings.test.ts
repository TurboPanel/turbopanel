import { assertEquals, assertExists } from '@std/assert'
import { hostingSchemas } from './hostings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type SchemaObject = {
  properties?: Record<string, unknown>
  required?: string[]
  enum?: string[]
  maxItems?: number
  $ref?: string
}

test('HostingOptions documents protocol, ports, web, and bind', () => {
  const options = hostingSchemas.HostingOptions as SchemaObject
  assertExists(options.properties)
  assertEquals(
    (options.properties.protocol as SchemaObject).enum,
    ['http', 'tcp', 'udp'],
  )
  assertEquals(
    (options.properties.bind as SchemaObject).enum,
    ['public', 'datacenter', 'local'],
  )
  assertEquals((options.properties.ports as SchemaObject).maxItems, 10)
  assertEquals(
    (options.properties.ports as { items: SchemaObject }).items.$ref,
    '#/components/schemas/HostingPortMapping',
  )
  assertEquals(
    (options.properties.web as SchemaObject).$ref,
    '#/components/schemas/HostingWebOptions',
  )
})

test('HostingPortMapping requires published and target', () => {
  const mapping = hostingSchemas.HostingPortMapping as SchemaObject
  assertEquals(mapping.required, ['published', 'target'])
})

test('HostingWebOptions exposes env and php', () => {
  const web = hostingSchemas.HostingWebOptions as SchemaObject
  assertExists(web.properties?.env)
  assertEquals(
    (web.properties?.php as SchemaObject).$ref,
    '#/components/schemas/HostingPhpOptions',
  )
  const php = hostingSchemas.HostingPhpOptions as SchemaObject
  assertExists(php.properties?.version)
  assertExists(php.properties?.memoryLimit)
  assertExists(php.properties?.maxExecutionTime)
})
