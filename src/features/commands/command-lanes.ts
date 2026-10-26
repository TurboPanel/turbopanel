/**
 * Per-server lanes for the command consumer.
 *
 * Commands for one server run one at a time, in the order they arrived, so
 * two commands for the same managed service (which always sit on one server)
 * never overlap. Commands for different servers run side by side, up to a
 * cap, so a slow apply on one server no longer holds up every other server.
 * Lanes take turns when the cap is reached, so one busy server cannot starve
 * the rest.
 *
 * A task may give its lane up before it ends by calling the `release` it is
 * handed: the next command for that server starts while the task keeps going
 * (a deploy the server has taken over and that is only being waited on). A
 * released task no longer counts toward the cap.
 */

export type LaneScheduler = {
  /**
   * Queue `task` behind earlier tasks with the same key; resolves with its
   * result. `release` frees the lane early; calling it again does nothing.
   */
  run<T>(key: string, task: (release: () => void) => Promise<T>): Promise<T>
  /** Tasks currently holding a lane (never above the cap). */
  activeCount(): number
}

type Job = {
  start(release: () => void): Promise<void>
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

  /** Free `lane` once, when its task ends or gives it up, and start what waits. */
  function releaser(key: string, lane: Lane): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      active--
      lane.running = false
      if (lane.pending.length > 0) {
        ready.push(key)
      } else {
        lanes.delete(key)
      }
      pump()
    }
  }

  function pump(): void {
    while (active < maxConcurrent) {
      const key = ready.shift()
      if (key === undefined) return
      const lane = lanes.get(key)
      const job = lane?.pending.shift()
      if (!lane || !job) continue
      lane.running = true
      active++
      const release = releaser(key, lane)
      void job.start(release).finally(release)
    }
  }

  return {
    run<T>(key: string, task: (release: () => void) => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let lane = lanes.get(key)
        if (!lane) {
          lane = { pending: [], running: false }
          lanes.set(key, lane)
        }
        lane.pending.push({
          start: (release) =>
            Promise.resolve()
              .then(() => task(release))
              .then(resolve, reject),
        })
        if (!lane.running && !ready.includes(key)) ready.push(key)
        pump()
      })
    },
    activeCount: () => active,
  }
}
