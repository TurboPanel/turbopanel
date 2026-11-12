/**
 * Retry waits that end at once when their owner shuts down, so a reconnect
 * loop never keeps a timer (or the process) alive past `close()`.
 */
export type ClosablePause = {
  /** Wait `ms`, or less if {@link ClosablePause.close} is called; resolves at once after close. */
  pause(ms: number): Promise<void>
  /** End the current wait and make every later one resolve at once. */
  close(): void
}

export function createClosablePause(): ClosablePause {
  let closed = false
  const waking = new Set<() => void>()
  return {
    pause(ms: number): Promise<void> {
      if (closed) return Promise.resolve()
      return new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          waking.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, ms)
        waking.add(wake)
      })
    },
    close(): void {
      closed = true
      // Deleting the current entry while iterating a Set is safe.
      for (const wake of waking) wake()
    },
  }
}
