/**
 * Per-server lanes for the command consumer.
 *
 * Commands for one server run one at a time, in the order they arrived, so
 * two commands for the same managed service (which always sit on one server)
 * never overlap. Commands for different servers run side by side, up to a
 * cap, so a slow apply on one server no longer holds up every other server.
 * Lanes take turns when the cap is reached, so one busy server cannot starve
 * the rest.
 */

export type LaneScheduler = {
  /** Queue `task` behind earlier tasks with the same key; resolves with its result. */
  run<T>(key: string, task: () => Promise<T>): Promise<T>
  /** Tasks currently running (never above the cap). */
  activeCount(): number
}

type Job = {
  start(): Promise<void>
}

type Lane = {
  pending: Job[]
  running: boolean
}

export function createLaneScheduler(options: { maxConcurrent: number }): LaneScheduler {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent))
  const lanes = new Map<string, Lane>()
  /** Idle lanes that have work, oldest first. */
  const ready: string[] = []
  let active = 0

  function pump(): void {
    while (active < maxConcurrent) {
      const key = ready.shift()
      if (key === undefined) return
      const lane = lanes.get(key)
      const job = lane?.pending.shift()
      if (!lane || !job) continue
      lane.running = true
      active++
      void job.start().finally(() => {
        active--
        lane.running = false
        if (lane.pending.length > 0) {
          ready.push(key)
        } else {
          lanes.delete(key)
        }
        pump()
      })
    }
  }

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let lane = lanes.get(key)
        if (!lane) {
          lane = { pending: [], running: false }
          lanes.set(key, lane)
        }
        lane.pending.push({
          start: () => Promise.resolve().then(task).then(resolve, reject),
        })
        if (!lane.running && !ready.includes(key)) ready.push(key)
        pump()
      })
    },
    activeCount: () => active,
  }
}
