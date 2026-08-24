import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import {
  isGitProviderFailure,
  isRepositoryReadUnsupported,
  MAX_REPOSITORY_FILE_BYTES,
  type GitProviderSourceRow,
  type RepositoryEntry,
  type RepositoryFileEntry,
} from '../../lib/git/git-provider.ts'
import { resolveGitProvider } from '../../lib/git/git-provider.ts'
import { readRepositoryViaDaemon } from './read-repository.ts'

/**
 * Filenames the wizard probes. Fixed rather than caller-supplied: this route is
 * reachable by any org member, and a fixed set bounds what a compromised
 * session can learn to "do these 13 names exist".
 */
export const INSPECT_PROBE_PATHS: readonly string[] = [
  'docker-compose.yml',
  'compose.yaml',
  'composer.json',
  'package.json',
  'index.php',
  'index.html',
  'Dockerfile',
]

export type InspectOutcome =
  | {
    ok: true
    commitSha: string
    files: RepositoryFileEntry[]
    entries: RepositoryEntry[]
    via: 'provider' | 'daemon'
  }
  | { ok: false; status: number; error: string; message: string }

/**
 * Read a repository, provider-first with a daemon fallback.
 *
 * The fallback rule is the whole LAN-egress story, and it needs no
 * configuration toggle:
 *
 * - A provider failure **with** an HTTP status means the provider answered
 *   (401/403/404/429). Surface it — the daemon would be told the same thing.
 * - A provider failure **without** a status means the fetch never got an HTTP
 *   answer, i.e. a reachability problem. The daemon may reach what the instance
 *   cannot, so fall back.
 * - `unsupported` means the provider has no read API for this source at all
 *   (a bare git remote, a GitLab deploy key). Fall back.
 */
export async function inspectRepository(params: {
  db: Db
  registry: DaemonCellRegistry | null
  dataEncryptionSecrets: DerivedSecretsConfig | null
  organizationId: string
  row: GitProviderSourceRow
  ref: string
  paths?: readonly string[]
  listPath?: string
  serverIds: readonly string[]
  /** Sealed clone credential for the daemon lane, when the source has one. */
  daemonCredential?: {
    credential: string
    credentialKind?: string
    credentialUsername?: string
  }
}): Promise<InspectOutcome> {
  const paths = params.paths ?? INSPECT_PROBE_PATHS
  const provider = resolveGitProvider(params.row.provider)
  const ctx = {
    db: params.db,
    ...(params.dataEncryptionSecrets
      ? { dataEncryptionSecrets: params.dataEncryptionSecrets }
      : {}),
  }

  const read = await provider.readRepositoryFiles(ctx, {
    row: params.row,
    ref: params.ref,
    paths,
    maxBytesPerFile: MAX_REPOSITORY_FILE_BYTES,
  })

  if (!isRepositoryReadUnsupported(read) && !isGitProviderFailure(read)) {
    let entries: RepositoryEntry[] = []
    if (params.listPath !== undefined) {
      const listed = await provider.listRepositoryEntries(ctx, {
        row: params.row,
        ref: params.ref,
        path: params.listPath,
      })
      if (!isRepositoryReadUnsupported(listed) && !isGitProviderFailure(listed)) {
        entries = listed.entries
      }
    }
    return {
      ok: true,
      commitSha: read.commitSha,
      files: read.files,
      entries,
      via: 'provider',
    }
  }

  // The provider answered with a real HTTP status: that IS the answer.
  if (isGitProviderFailure(read) && typeof read.status === 'number') {
    return {
      ok: false,
      status: read.status === 404 ? 404 : 502,
      error: 'source_read_failed',
      message: read.failure,
    }
  }

  if (!params.registry) {
    return {
      ok: false,
      status: 503,
      error: 'no_daemon_available',
      message:
        'This repository can only be read through a connected server, and none is available.',
    }
  }

  const viaDaemon = await readRepositoryViaDaemon(params.db, params.registry, {
    organizationId: params.organizationId,
    cloneUrl: params.row.repositoryUrl,
    ref: params.ref,
    paths,
    ...(params.listPath === undefined ? {} : { listPath: params.listPath }),
    maxBytesPerFile: MAX_REPOSITORY_FILE_BYTES,
    ...(params.daemonCredential ?? {}),
    serverIds: params.serverIds,
  })

  if (!viaDaemon.ok) {
    return {
      ok: false,
      status: viaDaemon.code === 'no_daemon_available' ? 503 : 502,
      error: viaDaemon.code,
      message: viaDaemon.message,
    }
  }
  return {
    ok: true,
    commitSha: viaDaemon.commitSha,
    files: viaDaemon.files,
    entries: viaDaemon.entries,
    via: 'daemon',
  }
}
