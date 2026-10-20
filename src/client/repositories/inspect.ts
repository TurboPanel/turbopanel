import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  isGitProviderFailure,
  isRepositoryReadUnsupported,
  MAX_REPOSITORY_FILE_BYTES,
  type GitProviderFailure,
  type GitProviderSourceRow,
  type RepositoryEntry,
  type RepositoryFileEntry,
} from '../../features/git/git-provider.ts'
import { resolveGitProvider } from '../../features/git/git-provider.ts'
import { isGithubDotComHttpsCloneUrl } from '../../features/git/clone-url.ts'
import { logWarn } from '../../lib/logger.ts'
import { readRepositoryViaDaemon } from './read-repository.ts'

/**
 * Public github.com HTTPS clones are stored as `provider: 'git'` (no App),
 * but anonymous REST can still read them. Use the GitHub adapter for those
 * rows so inspect does not wait on a daemon clone.
 */
function providerForInspect(row: GitProviderSourceRow) {
  if (!row.secretId && isGithubDotComHttpsCloneUrl(row.repositoryUrl)) {
    return resolveGitProvider('github')
  }
  return resolveGitProvider(row.provider)
}

/**
 * Filenames the wizard probes. Fixed rather than caller-supplied: this route is
 * reachable by any org member, and a fixed set bounds what a compromised
 * session can learn to "do these names exist".
 *
 * The lockfiles are probed for existence only — which one is present is what
 * tells the wizard the package manager before the app is created. Their content
 * rides along like any probed file but nothing reads it.
 */
export const INSPECT_PROBE_PATHS: readonly string[] = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
  'compose.yml',
  'composer.json',
  'package.json',
  '.nvmrc',
  '.node-version',
  '.tool-versions',
  'index.php',
  'index.html',
  'Dockerfile',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]

export type InspectOutcome =
  | {
      ok: true
      commitSha: string
      files: RepositoryFileEntry[]
      entries: RepositoryEntry[]
      via: 'provider' | 'daemon'
    }
  | { ok: false; status: number; error: string; message: string; ref?: string }

/**
 * What git prints when the remote has no such ref: `git fetch origin <ref>`
 * ("couldn't find remote ref") and `git clone --branch <ref>` ("Remote branch
 * <ref> not found"). The daemon sends git's stderr through `sanitizeForLog`,
 * which keeps these phrases.
 */
const GIT_REF_NOT_FOUND_RE = /couldn't find remote ref|remote branch .+ not found/i

/** Whether a failed daemon read means only "that ref does not exist". */
export function isGitRefNotFoundMessage(message: string): boolean {
  return GIT_REF_NOT_FOUND_RE.test(message)
}

/** The answer for a ref the repository does not have: the caller's input, not an outage. */
export function refNotFoundOutcome(ref: string): InspectOutcome {
  return {
    ok: false,
    status: 404,
    error: 'ref_not_found',
    message: `This repository has no branch, tag or commit called "${ref}".`,
    ref,
  }
}

/**
 * Plain sentences for the daemon lane's failures. git's stderr and the
 * daemon's own wording go to the log, never into the response: they can name
 * commands, paths and remotes, and they mean nothing to the person reading
 * the wizard.
 */
const DAEMON_FAILURE_MESSAGES: Readonly<Record<'timeout' | 'failed', string>> = {
  timeout: 'The connected server took too long to read this repository. Try again in a moment.',
  failed: 'The connected server could not read this repository.',
}

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
export type InspectRepositoryParams = {
  db: Db
  registry: DaemonCellRegistry | null
  dataEncryptionSecrets: DerivedSecretsConfig | null
  organizationId: string
  row: GitProviderSourceRow
  ref: string
  paths?: readonly string[]
  listPath?: string
  serverIds: readonly string[]
  /**
   * Ask a connected server when the provider turns the read away for its rate
   * limit (429, or 403 on an anonymous read), instead of answering with that.
   * A server clones over git, which that limit does not cover. Deploy-prepare
   * sets it; the wizard's inspect route reports the limit as it always has.
   */
  daemonOnRateLimit?: boolean
  /** Sealed clone credential for the daemon lane, when the source has one. */
  daemonCredential?: {
    credential: string
    credentialKind?: string
    credentialUsername?: string
  }
}

/**
 * The optional directory listing that rides along with a provider read.
 *
 * A listing that fails degrades to no entries rather than to an error: the
 * files the caller actually asked for were already read, and the listing is a
 * browsing aid on top of them.
 */
async function listEntriesViaProvider(
  provider: ReturnType<typeof resolveGitProvider>,
  ctx: { db: Db; dataEncryptionSecrets?: DerivedSecretsConfig },
  params: InspectRepositoryParams
): Promise<RepositoryEntry[]> {
  if (params.listPath === undefined) return []
  const listed = await provider.listRepositoryEntries(ctx, {
    row: params.row,
    ref: params.ref,
    path: params.listPath,
  })
  if (isRepositoryReadUnsupported(listed) || isGitProviderFailure(listed)) {
    return []
  }
  return listed.entries
}

/** The daemon lane, taken once the provider has declined or gone unreachable. */
async function inspectViaDaemon(
  params: InspectRepositoryParams,
  paths: readonly string[]
): Promise<InspectOutcome> {
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
    ...params.daemonCredential,
    serverIds: params.serverIds,
  })

  if (!viaDaemon.ok) {
    if (viaDaemon.code === 'no_daemon_available') {
      return { ok: false, status: 503, error: viaDaemon.code, message: viaDaemon.message }
    }
    if (viaDaemon.code === 'failed' && isGitRefNotFoundMessage(viaDaemon.message)) {
      return refNotFoundOutcome(params.ref)
    }
    // The daemon already sanitized this text for logs (a git error can echo
    // the clone URL); it is kept here, not in the response.
    logWarn(
      'repository-inspect',
      `daemon read failed repositoryId=${params.row.id} code=${viaDaemon.code}:`,
      viaDaemon.message
    )
    return {
      ok: false,
      status: 502,
      error: viaDaemon.code,
      message: DAEMON_FAILURE_MESSAGES[viaDaemon.code],
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

/**
 * A provider answer that only means "too many requests": 429 always, and 403
 * on an anonymous read (no installation, no stored secret), which is how the
 * forge reports its unauthenticated limit — a private repository read
 * anonymously answers 404, not 403.
 */
export function isRateLimited(status: number, row: GitProviderSourceRow): boolean {
  if (status === 429) return true
  return status === 403 && !row.connectionId && !row.secretId
}

/**
 * Whether a provider read that did not succeed is the answer, rather than a
 * reason to ask a connected server.
 *
 * A real HTTP status is the answer (the server would be told the same thing),
 * unless it is only the provider's rate limit and the caller asked for a
 * server then (`daemonOnRateLimit`). No status (unreachable) or no read API at
 * all goes to a server.
 */
export function providerAnswerStands(
  read: unknown,
  params: Pick<InspectRepositoryParams, 'row' | 'daemonOnRateLimit'>
): read is GitProviderFailure & { status: number } {
  if (!isGitProviderFailure(read) || typeof read.status !== 'number') return false
  return !(params.daemonOnRateLimit === true && isRateLimited(read.status, params.row))
}

export async function inspectRepository(params: InspectRepositoryParams): Promise<InspectOutcome> {
  const paths = params.paths ?? INSPECT_PROBE_PATHS
  const provider = providerForInspect(params.row)
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
    return {
      ok: true,
      commitSha: read.commitSha,
      files: read.files,
      entries: await listEntriesViaProvider(provider, ctx, params),
      via: 'provider',
    }
  }

  if (providerAnswerStands(read, params)) {
    if (read.reason === 'ref_not_found') return refNotFoundOutcome(params.ref)
    return {
      ok: false,
      status: read.status === 404 ? 404 : 502,
      error: 'source_read_failed',
      message: read.failure,
    }
  }

  return await inspectViaDaemon(params, paths)
}
