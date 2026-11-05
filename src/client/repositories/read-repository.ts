import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../../contracts/cell-protocol.ts'
import { cellTrace } from '../../lib/logger.ts'
import { isDaemonReadableCloneUrl } from '../../features/git/clone-url.ts'
import { loadServerStatusRecords } from '../servers/update-status.ts'
import type { RepositoryEntry, RepositoryFileEntry } from '../../features/git/git-provider.ts'

/**
 * On an operator's request path, not a deploy's — 30s, not the 600s a release
 * checkout gets.
 */
export const REPO_READ_TIMEOUT_MS = 30_000

/** The answer for a clone URL no server is asked to read. */
const REFUSED_ADDRESS = {
  ok: false,
  code: 'failed',
  message:
    'This repository address is not https://, ssh:// or user@host:path, so no server reads it.',
} as const

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
  }
): Promise<RepoReadOutcome> {
  const answer = await askConnectedServer(db, registry, {
    cloneUrl: params.cloneUrl,
    serverIds: params.serverIds,
    words: {
      noServer:
        'No connected server can read this repository. Connect a server, or paste the compose file instead.',
      timeout: 'timeout reading repository',
      failed: 'failed to read repository',
      malformed: 'malformed repository read result',
    },
    envelope: (ids) => ({
      kind: 'repo-read-request',
      ...ids,
      cloneUrl: params.cloneUrl,
      ref: params.ref,
      paths: [...params.paths],
      ...(params.listPath === undefined ? {} : { listPath: params.listPath }),
      maxBytesPerFile: params.maxBytesPerFile,
      ...(params.credential === undefined ? {} : { credential: params.credential }),
      ...(params.credentialKind === undefined ? {} : { credentialKind: params.credentialKind }),
      ...(params.credentialUsername === undefined
        ? {}
        : { credentialUsername: params.credentialUsername }),
      at: new Date().toISOString(),
    }),
  })
  if (!answer.ok) return answer
  const payload = answer.payload
  return {
    ok: true,
    commitSha: typeof payload.commitSha === 'string' ? payload.commitSha : '',
    files: normalizeFiles(payload.files),
    entries: normalizeEntries(payload.entries),
  }
}

type RoundTripFailure = {
  ok: false
  code: 'no_daemon_available' | 'timeout' | 'failed'
  message: string
}

/**
 * One correlated request to the first connected candidate server, shared by
 * both reads: the address check, the server pick, the wait and the failure
 * mapping. Answers the result payload only when the server said `ok: true`.
 */
async function askConnectedServer(
  db: Db,
  registry: DaemonCellRegistry,
  params: {
    cloneUrl: string
    serverIds: readonly string[]
    words: { noServer: string; timeout: string; failed: string; malformed: string }
    envelope: (ids: { deliveryId: string; requestId: string }) => DaemonOutboundEnvelope
  }
): Promise<{ ok: true; payload: Record<string, unknown> } | RoundTripFailure> {
  if (!isDaemonReadableCloneUrl(params.cloneUrl)) return REFUSED_ADDRESS
  const records = await loadServerStatusRecords(db, registry, [...params.serverIds])
  const online = records.find((record) => record?.connected)
  if (!online) {
    return { ok: false, code: 'no_daemon_available', message: params.words.noServer }
  }

  const requestId = generateRequestId()
  const envelope = params.envelope({ deliveryId: generateDeliveryId(), requestId })
  cellTrace('request-start', { requestId, serverId: online.serverId, kind: envelope.kind })

  const record = await registry
    .getCell(online.serverId)
    .createRequestAndWait(envelope, REPO_READ_TIMEOUT_MS)

  if (record.status === 'expired') {
    return { ok: false, code: 'timeout', message: params.words.timeout }
  }
  if (record.status === 'failed') {
    return { ok: false, code: 'failed', message: record.error ?? params.words.failed }
  }
  const result = record.result
  if (typeof result !== 'object' || result === null) {
    return { ok: false, code: 'failed', message: params.words.malformed }
  }
  const payload = result as Record<string, unknown>
  if (payload.ok !== true) {
    return {
      ok: false,
      code: 'failed',
      message: typeof payload.error === 'string' ? payload.error : params.words.failed,
    }
  }
  return { ok: true, payload }
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
      reason:
        reason === 'too_large' || reason === 'not_a_file' || reason === 'binary'
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

export type ResolveDefaultBranchOutcome =
  | { ok: true; defaultBranch: string | null }
  | { ok: false; code: 'no_daemon_available' | 'timeout' | 'failed'; message: string }

/**
 * The remote's default branch, through a **daemon** — `git ls-remote
 * --symref`, no clone.
 *
 * Anonymous only, unlike {@link readRepositoryViaDaemon}: this exists for a
 * public clone URL whose default branch GitHub REST could not name, so it
 * never carries a credential. A keyed private remote that REST cannot see
 * still lands with no default branch.
 */
export async function resolveDefaultBranchViaDaemon(
  db: Db,
  registry: DaemonCellRegistry,
  params: {
    organizationId: string
    cloneUrl: string
    /** Candidate servers, most-preferred first. */
    serverIds: readonly string[]
  }
): Promise<ResolveDefaultBranchOutcome> {
  const answer = await askConnectedServer(db, registry, {
    cloneUrl: params.cloneUrl,
    serverIds: params.serverIds,
    words: {
      noServer: 'No connected server can resolve the default branch.',
      timeout: 'timeout resolving default branch',
      failed: 'failed to resolve default branch',
      malformed: 'malformed default-branch result',
    },
    envelope: (ids) => ({
      kind: 'repo-default-branch-request',
      ...ids,
      cloneUrl: params.cloneUrl,
      at: new Date().toISOString(),
    }),
  })
  if (!answer.ok) return answer
  const branch = answer.payload.defaultBranch
  return { ok: true, defaultBranch: typeof branch === 'string' ? branch : null }
}
