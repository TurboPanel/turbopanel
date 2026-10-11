import { assertEquals } from '@std/assert'
import { applyServiceOptionsToComposeDocument } from './apply-service-options.ts'
import { emptyComposeDocument } from './types.ts'

Deno.test('an authored restart: is not overridden by a generated restart_policy', () => {
  const doc = emptyComposeDocument()
  doc.data.services = {
    web: { image: 'nginx:alpine', restart: 'unless-stopped' },
    worker: { image: 'nginx:alpine' },
  }
  const result = applyServiceOptionsToComposeDocument(doc, new Map(), new Map())
  const services = result.document.data.services as Record<string, Record<string, unknown>>
  assertEquals(services.web.restart, 'unless-stopped')
  assertEquals(
    (services.web.deploy as Record<string, unknown> | undefined)?.restart_policy,
    undefined
  )
  // A service that did not author `restart:` keeps the platform limit.
  assertEquals(
    (services.worker.deploy as Record<string, unknown>).restart_policy !== undefined,
    true
  )
})
