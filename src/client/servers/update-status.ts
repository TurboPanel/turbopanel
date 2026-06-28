import type { PendingRequestRecord, PendingRequestStatus } from '../../daemon/cell/contracts.ts'
import { UPDATE_PENDING_MS } from '../../lib/update/constants.ts'
import {
  resolveTrunkManifest,
  type TrunkManifestTarget,
} from '../../lib/update/manifest.ts'

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  'done',
  'failed',
  'expired',
])

function isTerminalRequestStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

function pickLatestUpdateRequest(
  requests: PendingRequestRecord[],
): PendingRequestRecord | undefined {
  if (requests.length === 0) return undefined
  return requests.reduce((latest, candidate) => {
    const latestMs = Date.parse(latest.createdAt)
    const candidateMs = Date.parse(candidate.createdAt)
    if (Number.isNaN(latestMs) || Number.isNaN(candidateMs)) {
      return candidate
    }
    return candidateMs > latestMs ? candidate : latest
  })
}

export type ServerUpdateCommit = {
  commit: string
  buildId: string
  builtAt?: string
}

export const COLOCATED_SERVER_UPDATE_BLOCKED_REASON =
  'The co-located development daemon cannot be updated from the control plane'

export function colocatedServerUpdateBlockedReason(): string {
  return COLOCATED_SERVER_UPDATE_BLOCKED_REASON
}

export type ServerUpdateGetResponse = {
  ok: boolean
  serverId: string
  channel: string
  current: ServerUpdateCommit | null
  target: (ServerUpdateCommit & { manifestUrl?: string }) | null
  updateAvailable: boolean
  colocatedWithInstance?: boolean
  updateBlocked?: boolean
  updateBlockedReason?: string
  status: 'idle' | 'updating' | 'error'
  targetStatus: 'ok' | 'unknown'
  targetError?: string
}

export async function resolveServerUpdateStatus(params: {
  serverId: string
  current: ServerUpdateCommit | null
  listUpdateRequests: () => Promise<PendingRequestRecord[]>
  /** When batching status checks, pass a shared manifest lookup result. */
  targetManifest?: TrunkManifestTarget | null
  /** Co-located daemon on this control plane host — remote trunk updates blocked. */
  colocatedWithInstance?: boolean
}): Promise<
  Pick<
    ServerUpdateGetResponse,
    | 'target'
    | 'updateAvailable'
    | 'updateBlocked'
    | 'updateBlockedReason'
    | 'status'
    | 'targetStatus'
    | 'targetError'
  >
> {
  const manifest = params.targetManifest !== undefined
    ? params.targetManifest
    : await resolveTrunkManifest()
  const target = manifest
    ? {
      commit: manifest.commit,
      buildId: manifest.buildId,
      builtAt: manifest.builtAt,
      manifestUrl: manifest.manifestUrl,
    }
    : null

  const targetStatus = target ? 'ok' as const : 'unknown' as const
  const targetError = target
    ? undefined
    : 'Could not resolve trunk channel manifest'

  const commitDrift = target
    ? params.current?.commit !== target.commit
    : false
  const updateBlocked = params.colocatedWithInstance === true
  const updateAvailable = updateBlocked ? false : commitDrift

  let status: ServerUpdateGetResponse['status'] = 'idle'

  const requests = await params.listUpdateRequests()
  const latest = pickLatestUpdateRequest(requests)

  if (latest) {
    if (!isTerminalRequestStatus(latest.status)) {
      status = 'updating'
    } else if (latest.status === 'failed' || latest.status === 'expired') {
      // Stale control-plane failures are not actionable once the daemon matches trunk
      // (e.g. operator updated the node manually out of band).
      if (updateAvailable) {
        status = 'error'
      }
    } else if (
      latest.status === 'done' &&
      target &&
      params.current?.commit !== target.commit
    ) {
      const finishedAt = latest.finishedAt ? Date.parse(latest.finishedAt) : NaN
      if (!Number.isNaN(finishedAt) && Date.now() - finishedAt < UPDATE_PENDING_MS) {
        status = 'updating'
      }
    }
  }

  return {
    target,
    updateAvailable,
    ...(updateBlocked
      ? {
        updateBlocked: true,
        updateBlockedReason: colocatedServerUpdateBlockedReason(),
      }
      : {}),
    status,
    targetStatus,
    targetError,
  }
}
