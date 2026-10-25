/**
 * The target's replication reading for the switchover journal: the stored one
 * when it is fresh enough, otherwise one fresh probe. Only Postgres is proven
 * by a reading. Never throws; `undefined` means no reading.
 */

import { isManagedReplicaObservationStale } from './promote-lag.ts'
import { SWITCHOVER_CATCHUP_MAX_AGE_MS } from './switchover-evidence.ts'

export async function readSwitchoverReplication(params: {
  engine: string
  stored: () => Promise<unknown>
  probe: () => Promise<unknown>
  nowMs?: number
}): Promise<unknown> {
  if (params.engine !== 'postgres') return undefined
  try {
    const current = await params.stored()
    const nowMs = params.nowMs ?? Date.now()
    if (!isManagedReplicaObservationStale(current, nowMs, SWITCHOVER_CATCHUP_MAX_AGE_MS)) {
      return current
    }
    return await params.probe()
  } catch {
    return undefined
  }
}
