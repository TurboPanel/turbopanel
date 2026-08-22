import { assertEquals } from '@std/assert'
import { expandComposeServiceInstances } from './expand-instances.ts'
import type { ComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function doc(services: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data: { services },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

test('expandComposeServiceInstances leaves single-instance keys untouched', () => {
  const result = expandComposeServiceInstances(
    doc({ web: { image: 'nginx' }, worker: { image: 'busybox' } }),
    new Map([['web', 1], ['worker', 1]]),
  )
  assertEquals(Object.keys(result.document.data.services as object), ['web', 'worker'])
  assertEquals(result.expansion.get('web'), ['web'])
})

test('expandComposeServiceInstances fans multi-instance into sibling keys', () => {
  const result = expandComposeServiceInstances(
    doc({ web: { image: 'nginx', environment: { A: '1' } } }),
    new Map([['web', 3]]),
  )
  const services = result.document.data.services as Record<string, Record<string, unknown>>
  assertEquals(Object.keys(services), ['web-1', 'web-2', 'web-3'])
  assertEquals(result.expansion.get('web'), ['web-1', 'web-2', 'web-3'])
  assertEquals(services['web-1']!.image, 'nginx')
  assertEquals(services['web-2']!.environment, { A: '1' })
})

test('expandComposeServiceInstances skips traditional-web services', () => {
  const result = expandComposeServiceInstances(
    doc({
      site: {
        'x-turbopanel': { serviceKind: 'traditional-web', engine: 'nginx' },
      },
    }),
    new Map([['site', 3]]),
  )
  assertEquals(Object.keys(result.document.data.services as object), ['site'])
  assertEquals(result.expansion.get('site'), ['site'])
})

test('expandComposeServiceInstances passes through non-record services', () => {
  const result = expandComposeServiceInstances(
    doc({ broken: 'not-a-map' }),
    new Map([['broken', 3]]),
  )
  assertEquals((result.document.data.services as Record<string, unknown>).broken, 'not-a-map')
  assertEquals(result.expansion.get('broken'), ['broken'])
})
