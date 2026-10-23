import { assertEquals } from '@std/assert'
import { PEAK_WINDOW_DAYS, peakBucket } from './peak.ts'

const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-10-23T12:30:00.000Z')

test('peakBucket is the start of the UTC hour', () => {
  assertEquals(peakBucket(NOW), '2026-10-23T12:00:00.000Z')
  assertEquals(PEAK_WINDOW_DAYS, 7)
})
