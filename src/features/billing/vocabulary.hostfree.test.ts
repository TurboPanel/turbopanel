/**
 * Billing vocabulary: customers buy and release licenses and add servers; the
 * word "seat" never reaches the API reference. `seat` survives only as an
 * identifier (the `/billing/seats` path, the `release-seat` change kind).
 */

import { assertEquals } from '@std/assert'
import { getWorkersAdminOpenApiSpec } from '../../admin/openapi/workers.ts'
import { getWorkersClientOpenApiSpec } from '../../client/openapi/workers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const COPY_KEYS = new Set(['description', 'summary', 'title'])
const SEAT_WORD = /\bseats?\b/i

/** Route and enum identifiers that legitimately contain the old word. */
function withoutIdentifiers(text: string): string {
  return text.replaceAll('/billing/seats', '').replaceAll('release-seat', '')
}

/** Every human-readable string (description / summary / title) in a spec. */
function copyStrings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) copyStrings(item, out)
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (COPY_KEYS.has(key) && typeof value === 'string') out.push(value)
      else copyStrings(value, out)
    }
  }
  return out
}

function offenders(spec: object): string[] {
  return copyStrings(spec)
    .map(withoutIdentifiers)
    .filter((text) => SEAT_WORD.test(text))
}

test('the billing API reference says licenses and servers, never seats', () => {
  const spec = getWorkersClientOpenApiSpec('https://panel.example.com')
  const copy = copyStrings(spec)
  // The scan really reads the billing copy (guards against an empty walk).
  assertEquals(
    copy.some((text) => text.includes('licenses_ending')),
    true
  )
  assertEquals(offenders(spec), [])
})

test('the admin tier reference says licenses, never seats', () => {
  const spec = getWorkersAdminOpenApiSpec('https://panel.example.com')
  assertEquals(
    copyStrings(spec).some((text) => text.includes('ladder')),
    true
  )
  assertEquals(offenders(spec), [])
})

test('the identifier carve-out is narrow: the path and the kind are exempt, prose is not', () => {
  assertEquals(SEAT_WORD.test(withoutIdentifiers('use `/billing/seats` or release-seat')), false)
  assertEquals(SEAT_WORD.test(withoutIdentifiers('buy two more seats')), true)
  assertEquals(SEAT_WORD.test(withoutIdentifiers('Seat cap')), true)
})
