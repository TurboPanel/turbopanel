import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../../daemon/cell/protocol.ts'
import { cellTrace } from '../../logger.ts'
import { loadServerStatusRecords } from '../servers/update-status.ts'
import type {
  RepositoryEntry,
  RepositoryFileEntry,
} from '../../lib/git/git-provider.ts'

/**
 * On an operator's request path, not a deploy's — 30s, not the 600s a release
 * checkout gets.
 */
export const REPO_READ_TIMEOUT_MS = 30_000

export type RepoReadOutcome =
  | { ok: true; commitSha: string; files: RepositoryFileEntry[]; entries: RepositoryEntry[] }
  | { ok: false; code: 'no_daemon_available' | 'timeout' | 'failed'; message: string }

/**
 * Read repository files through a **daemon**, when the provider cannot.
 *
 * Uses the correlated cell request channel (`createRequestAndWait`), not a new
 * command type. Reading a file is interactive, read-only, and has no desired
 * state; a command row per read would pollute the append-only ledger that backs
 * deploy history, and the caller would have to poll for a result it needs
 * inside one HTTP request. The channel already provides correlation, timeouts,
 * size caps, and an inbound allowlist.
 */
export async function readRepositoryViaDaemon(
  db: Db,
  registry: DaemonCellRegistry,
  params: {
    organizationId: string
    cloneUrl: string
    ref: string
    paths: readonly string[]
    listPath?: string
    maxBytesPerFile: number
    credential?: string
    credentialKind?: string
    credentialUsername?: string
    /** Candidate servers, most-preferred first. */
    serverIds: readonly string[]
  },
): Promise<RepoReadOutcome> {
  const records = await loadServerStatusRecords(db, registry, [
    ...params.serverIds,
  ])
  const online = records.find((record) => record?.connected)
  if (!online) {
    return {
      ok: false,
      code: 'no_daemon_available',
      message:
        'No connected server can read this repository. Connect a server, or paste the compose file instead.',
    }
  }

  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'repo-read-request',
    deliveryId: generateDeliveryId(),
    requestId,
    cloneUrl: params.cloneUrl,
    ref: params.ref,
    paths: [...params.paths],
    ...(params.listPath === undefined ? {} : { listPath: params.listPath }),
    maxBytesPerFile: params.maxBytesPerFile,
    ...(params.credential === undefined ? {} : { credential: params.credential }),
    ...(params.credentialKind === undefined
      ? {}
      : { credentialKind: params.credentialKind }),
    ...(params.credentialUsername === undefined
      ? {}
      : { credentialUsername: params.credentialUsername }),
    at: new Date().toISOString(),
  }

  cellTrace('request-start', {
    requestId,
    serverId: online.serverId,
    kind: 'repo-read-request',
  })

  const record = await registry.getCell(online.serverId).createRequestAndWait(
    envelope,
    REPO_READ_TIMEOUT_MS,
  )

  if (record.status === 'expired') {
    return { ok: false, code: 'timeout', message: 'timeout reading repository' }
  }
  if (record.status === 'failed') {
    return {
      ok: false,
      code: 'failed',
      message: record.error ?? 'failed to read repository',
    }
  }

  const result = record.result
  if (typeof result !== 'object' || result === null) {
    return { ok: false, code: 'failed', message: 'malformed repository read result' }
  }
  const payload = result as {
    ok?: unknown
    commitSha?: unknown
    files?: unknown
    entries?: unknown
    error?: unknown
  }
  if (payload.ok !== true) {
    return {
      ok: false,
      code: 'failed',
      message: typeof payload.error === 'string'
        ? payload.error
        : 'failed to read repository',
    }
  }
  return {
    ok: true,
    commitSha: typeof payload.commitSha === 'string' ? payload.commitSha : '',
    files: normalizeFiles(payload.files),
    entries: normalizeEntries(payload.entries),
  }
}

function normalizeFiles(raw: unknown): RepositoryFileEntry[] {
  if (!Array.isArray(raw)) return []
  const files: RepositoryFileEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.path !== 'string') continue
    if (entry.found === true && typeof entry.content === 'string') {
      files.push({
        path: entry.path,
        found: true,
        content: entry.content,
        bytes: typeof entry.bytes === 'number' ? entry.bytes : entry.content.length,
      })
      continue
    }
    const reason = entry.reason
    files.push({
      path: entry.path,
      found: false,
      reason: reason === 'too_large' || reason === 'not_a_file' || reason === 'binary'
        ? reason
        : 'not_found',
    })
  }
  return files
}

function normalizeEntries(raw: unknown): RepositoryEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: RepositoryEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.path !== 'string') continue
    entries.push({
      path: entry.path,
      kind: entry.kind === 'dir' ? 'dir' : 'file',
      ...(typeof entry.bytes === 'number' ? { bytes: entry.bytes } : {}),
    })
  }
  return entries
}
