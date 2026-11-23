import { assertEquals } from '@std/assert'
import { gapStillRunning } from './slot-gap.ts'

const MIN = 60_000
const TEN = 10 * MIN

Deno.test(
  'a ten minute wait on five minute slots runs at ten minute spacing despite jitter',
  () => {
    let lastRun = 0
    const runs: number[] = []
    // Each slot starts a few seconds late and the run's own clock reads later still.
    const jitter = [4_000, 9_000, 2_000, 14_000, 6_000, 11_000, 3_000, 8_000, 12_000]
    for (let slot = 1; slot <= 9; slot++) {
      const now = slot * 5 * MIN + jitter[slot - 1]
      if (runs.length === 0 || !gapStillRunning(now - lastRun, TEN)) {
        runs.push(now)
        lastRun = now + 20_000
      }
    }
    const spacing = runs.slice(1).map((t, i) => Math.round((t - runs[i]) / MIN))
    assertEquals(spacing, [10, 10, 10, 10])
  }
)

Deno.test('a wait still running well before the gap holds, and short gaps stay exact', () => {
  assertEquals(gapStillRunning(5 * MIN, TEN), true)
  assertEquals(gapStillRunning(TEN - 61_000, TEN), true)
  assertEquals(gapStillRunning(TEN - 59_000, TEN), false)
  assertEquals(gapStillRunning(119_000, 2 * MIN), true)
  assertEquals(gapStillRunning(2 * MIN, 2 * MIN), false)
  assertEquals(gapStillRunning(14_000, 15_000), true)
})
