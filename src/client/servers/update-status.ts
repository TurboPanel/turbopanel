import type { PendingRequestRecord, PendingRequestStatus } from '../../daemon/cell/contracts.ts'
import { resolveTrunkManifest } from '../../lib/update/manifest.ts'

const UPDATE_PENDING_MS = 120_000

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  'done',
  'failed',
  'expired',
])

function isTerminalRequestStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export type ServerUpdateCommit = {
  commit: string
  buildId: string
  builtAt?: string
}

export type ServerUpdateGetResponse = {
  ok: boolean
  serverId: string
  channel: string
  current: ServerUpdateCommit | null
  target: (ServerUpdateCommit & { manifestUrl?: string }) | null
  updateAvailable: boolean
  status: 'idle' | 'updating' | 'error'
  targetStatus: 'ok' | 'unknown'
  targetError?: string
}

export async function resolveServerUpdateStatus(params: {
  serverId: string
  current: ServerUpdateCommit | null
  listUpdateRequests: () => Promise<PendingRequestRecord[]>
}): Promise<
  Pick<
    ServerUpdateGetResponse,
    'target' | 'updateAvailable' | 'status' | 'targetStatus' | 'targetError'
  >
> {
  const manifest = await resolveTrunkManifest()
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

  const updateAvailable = target
    ? params.current?.commit !== target.commit
    : false

  let status: ServerUpdateGetResponse['status'] = 'idle'

  const requests = await params.listUpdateRequests()
  const latest = requests[0]

  if (latest) {
    if (!isTerminalRequestStatus(latest.status)) {
      status = 'updating'
    } else if (latest.status === 'failed' || latest.status === 'expired') {
      status = 'error'
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
    status,
    targetStatus,
    targetError,
  }
}
