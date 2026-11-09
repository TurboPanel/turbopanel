import { assertEquals, assertExists } from '@std/assert'
import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'
import { INSTANCE_HOSTNAME_SOURCES } from '../../features/install/instance-hostnames.ts'
import { INSTANCE_HOSTNAME_PATHS } from './instance-hostnames.ts'

const test = Deno.test.bind(Deno)

type Schema = {
  type?: string | string[]
  required?: string[]
  enum?: readonly string[]
  minimum?: number
  maximum?: number
  properties?: Record<string, Schema>
  items?: Schema
}

const put = INSTANCE_HOSTNAME_PATHS[`${ADMIN_API_PREFIX}/instance/hostnames`].put

function jsonSchema(holder: unknown): Schema {
  const schema = (holder as { content?: Record<string, { schema?: Schema }> }).content?.[
    'application/json'
  ]?.schema
  assertExists(schema)
  return schema
}

test('the hostname save documents the public port and the primary flag', () => {
  const entry = jsonSchema(put.requestBody).properties?.hostnames?.items
  assertExists(entry)
  assertEquals(entry.required, ['host', 'source'])
  assertEquals(entry.properties?.source?.enum, [...INSTANCE_HOSTNAME_SOURCES])
  const port = entry.properties?.publicPort
  assertEquals([port?.type, port?.minimum, port?.maximum], ['integer', 1, 65535])
  assertEquals(entry.properties?.isPrimary?.type, 'boolean')
})

test('the hostname save answer documents the primary change fields', () => {
  const answer = jsonSchema(put.responses['200'])
  assertEquals(answer.properties?.warnings?.items?.enum, [
    'primary-host-changed',
    'primary-origin-changed',
  ])
  assertEquals(answer.properties?.previousPrimaryOrigin?.type, 'string')
  assertEquals(answer.properties?.primaryOrigin?.type, ['string', 'null'])
})
