import {
  heartbeatSecondsFor,
  HEARTBEAT_SECONDS_DEFAULT,
} from '../../features/install/heartbeat-policy.ts'

export type HeartbeatReader = {
  /** Cached seconds; never touches the database, safe on the attach path. */
  read: () => number
  refresh: () => Promise<void>
}

/**
 * Caches the advised heartbeat so the daemon attach path makes no database
 * call. `loadModes` returns the mode of every panel hostname; a failed load
 * keeps the last good value.
 */
export function createHeartbeatReader(
  loadModes: () => Promise<readonly string[]>,
  onError: (err: unknown) => void = () => {}
): HeartbeatReader {
  let seconds = HEARTBEAT_SECONDS_DEFAULT
  return {
    read: () => seconds,
    refresh: async () => {
      try {
        seconds = heartbeatSecondsFor(await loadModes(), 'deno')
      } catch (err) {
        onError(err)
      }
    },
  }
}
