/**
 * Host-free coverage for `runHostLossTick` wiring: a failure in the host-loss
 * sweep must not stop the return fence, and neither failure may escape to the
 * cron or timer that calls the tick.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import { runHostLossTick } from './host-loss-tick.ts'

const test = Deno.test.bind(Deno)

test('a tick whose sweeps both fail still resolves, and each sweep is tried', async () => {
  let touches = 0
  // Every query builder call counts as one attempted read, then fails.
  const db = new Proxy(
    {},
    {
      get() {
        touches++
        throw new Error('database unavailable')
      },
    }
  ) as unknown as Db
  await runHostLossTick(db, {
    commandQueue: { enqueue: () => Promise.resolve() },
    registry: {} as DaemonCellRegistry,
    env: {},
  })
  // One touch per sweep proves the return fence ran after the host-loss sweep failed.
  assertEquals(touches >= 2, true)
})
