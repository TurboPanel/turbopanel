import { assertEquals } from '@std/assert'
import { spareCountsFromAssignment } from './server-preferred-tier.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('spareCountsFromAssignment lists only tiers with spare seats, sorted by label', () => {
  const spare = new Map([
    ['t-s2', 6],
    ['t-s1', 0],
    ['t-s3', 1],
  ])
  const tiers = [
    { id: 't-s3', label: 'S3' },
    { id: 't-s2', label: 'S2' },
    { id: 't-s1', label: 'S1' },
  ]
  assertEquals(spareCountsFromAssignment(spare, tiers), [
    { tierId: 't-s2', label: 'S2', free: 6 },
    { tierId: 't-s3', label: 'S3', free: 1 },
  ])
})
