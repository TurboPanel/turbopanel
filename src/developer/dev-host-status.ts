/**
 * The development host status the co-located daemon pushes
 * (`dev-host-status`, feature `dev-host-v1`), kept in this process only.
 *
 * Nothing is written to the database: the daemon re-sends on every attach and
 * at least every 60 s, so a restarted control plane is current again within a
 * minute. Only frames from the co-located daemon (the Unix-socket attach) are
 * handed here; `src/daemon/deno-ws.ts` drops the rest. Fed from
 * `src/deno-dev.ts` through the `onDevHostStatus` hook of `startDenoServer`,
 * so nothing here is reachable from the Workers or production entries.
 *
 * The store also remembers a host action the control plane just started, so
 * Build and Push Daemon refuses in the gap before the daemon's next status
 * names the job.
 */
import type { DevHostStatus } from '../contracts/cell-protocol.ts'

/** A status older than this no longer counts as a running job (the daemon re-sends every 60 s). */
export const DEV_HOST_STATUS_STALE_MS = 5 * 60_000

/** How long a started action counts as running before the daemon's status names it. */
export const DEV_HOST_PENDING_JOB_MS = 2 * 60_000

export type StoredDevHostStatus = {
  /** The co-located server the status came from. */
  serverId: string
  status: DevHostStatus
  /** Daemon clock (`at` on the frame). */
  at: string
  /** Control plane clock, epoch milliseconds. */
  receivedAtMs: number
}

export type DevHostStatusStore = {
  put(serverId: string, status: DevHostStatus, at: string, nowMs?: number): void
  get(): StoredDevHostStatus | null
  /** Record a job the daemon accepted, until a status names it. */
  noteJobStarted(jobId: string, nowMs?: number): void
  /** True while the daemon runs a host job, or one was just started. */
  isJobRunning(nowMs?: number): boolean
  clear(): void
}

export function createDevHostStatusStore(): DevHostStatusStore {
  let latest: StoredDevHostStatus | null = null
  let pending: { jobId: string; atMs: number } | null = null
  return {
    put(serverId, status, at, nowMs = Date.now()) {
      latest = { serverId, status: structuredClone(status), at, receivedAtMs: nowMs }
      if (pending && status.job?.id === pending.jobId) pending = null
    },
    get() {
      return latest ? structuredClone(latest) : null
    },
    noteJobStarted(jobId, nowMs = Date.now()) {
      pending = { jobId, atMs: nowMs }
    },
    isJobRunning(nowMs = Date.now()) {
      if (pending && nowMs - pending.atMs < DEV_HOST_PENDING_JOB_MS) return true
      if (!latest || nowMs - latest.receivedAtMs >= DEV_HOST_STATUS_STALE_MS) return false
      return latest.status.job?.state === 'running'
    },
    clear() {
      latest = null
      pending = null
    },
  }
}

/** The process-wide store the development entry feeds. */
export const devHostStatusStore: DevHostStatusStore = createDevHostStatusStore()
