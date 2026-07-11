import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  composeDocumentToRuntimeYaml,
  composeDocumentToYaml,
  emptyComposeDocument,
  mergeComposeOverlay,
  normalizeCompose,
  validateComposeDocument,
  yamlToComposeDocument,
} from './index.ts'

const SAMPLE = `version: "3.9"

# Web frontend
services:
  web: # primary
    image: nginx:alpine
    ports:
      - "8080:80"

networks:
  front: {}
`

Deno.test('yamlToComposeDocument preserves top-level key order and comments', () => {
  const doc = yamlToComposeDocument(SAMPLE)
  assertEquals(doc.version, 1)
  assertEquals(doc.presentation.keyOrder[0], 'version')
  assertEquals(doc.presentation.keyOrder.includes('services'), true)
  assertEquals(doc.presentation.keyOrder.includes('networks'), true)
  assertEquals(Object.keys(doc.presentation.comments).length > 0, true)

  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.includes('# Web frontend') || roundTrip.includes('primary'), true)
  // services section appears before networks
  assertEquals(roundTrip.indexOf('services:') < roundTrip.indexOf('networks:'), true)
})

Deno.test('composeDocumentToRuntimeYaml drops presentation-only concerns but keeps data', () => {
  const doc = yamlToComposeDocument(SAMPLE)
  const runtime = composeDocumentToRuntimeYaml(doc)
  assertEquals(runtime.includes('nginx:alpine'), true)
  assertEquals(runtime.includes('front:'), true)
})

Deno.test('normalizeCompose lifts legacy bare compose objects', () => {
  const legacy = { services: { api: { image: 'node:22' } } }
  const doc = normalizeCompose(legacy)
  assertEquals(doc.version, 1)
  assertEquals((doc.data.services as Record<string, unknown>).api, { image: 'node:22' })
  assertEquals(doc.presentation.keyOrder, ['services'])
})

Deno.test('emptyComposeDocument validates', () => {
  const empty = emptyComposeDocument()
  const result = validateComposeDocument(empty)
  assertEquals(result.ok, true)
})

Deno.test('mergeComposeOverlay deep-merges services', () => {
  const base = yamlToComposeDocument(`
services:
  web:
    image: nginx:alpine
  db:
    image: postgres:16
`)
  const overlay = yamlToComposeDocument(`
services:
  mailpit:
    image: axllent/mailpit
  web:
    ports:
      - "8080:80"
`)
  const merged = mergeComposeOverlay(base, overlay)
  const services = merged.data.services as Record<string, Record<string, unknown>>
  assertEquals(services.db.image, 'postgres:16')
  assertEquals(services.mailpit.image, 'axllent/mailpit')
  assertEquals(services.web.image, 'nginx:alpine')
  assertEquals(services.web.ports, ['8080:80'])
})

Deno.test('yamlToComposeDocument rejects invalid YAML', () => {
  assertThrows(
    () => yamlToComposeDocument('services: [\n  - broken'),
    Error,
  )
})

Deno.test('empty overlay inherits base', () => {
  const base = emptyComposeDocument()
  base.data = { services: { web: { image: 'nginx' } } }
  const merged = mergeComposeOverlay(base, emptyComposeDocument())
  assertEquals((merged.data.services as Record<string, unknown>).web, { image: 'nginx' })
})
