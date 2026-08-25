/**
 * GitHub as a {@link GitProvider}.
 *
 * A thin adapter, not a rewrite: every call below delegates to the modules that
 * already implemented this behaviour inline (`./github-app-token.ts`,
 * `./github-webhook.ts`), and the payload readers are the ones lifted verbatim
 * out of `src/client/git/github-webhook-routes.ts`. Nothing about GitHub's
 * behaviour changes here — the point is that deploy-prepare, the repository
 * picker, and the webhook ingress now reach it through one interface instead of
 * three `provider === 'github'` branches.
 *
 * Web APIs only (`fetch`, `crypto.subtle`) so the module stays reachable from
 * `src/workers.ts`.
 */

import { isGitProviderFailure } from './git-provider.ts'
import {
  MAX_REPOSITORY_FILE_BYTES,
  MAX_REPOSITORY_READ_PATHS,
} from './repository-read.ts'
import type {
  GitProviderSourceRow,
  ListRepositoryEntriesParams,
  ReadRepositoryFilesParams,
  RepositoryEntry,
  RepositoryFileEntry,
  RepositoryFileSet,
  RepositoryReadUnsupported,
  GitProvider,
  GitProviderContext,
  GitProviderFailure,
  PreparedClone,
  PrepareCloneParams,
  ProviderCheckEvent,
  ProviderPushEvent,
  RepositorySummary,
  ResolvedSourceCommit,
  WebhookHeaders,
} from './git-provider.ts'
import {
  branchFromGitRef,
  commitSubject,
  COMMIT_AUTHOR_MAX_CHARS,
  isCommitSha,
  parseRepositoryOwnerRepo,
  trimCommitField,
} from './clone-url.ts'
import {
  GITHUB_API_BASE,
  githubApiHeaders,
  GithubAppTokenError,
  mintGithubInstallationToken,
} from './github-app-token.ts'
import {
  GITHUB_SIGNATURE_HEADER,
  verifyGithubWebhookSignature,
} from './github-webhook.ts'

/** GitHub paginates installation repositories; walk a bounded number of pages. */
const REPOSITORY_PAGE_SIZE = 100
const REPOSITORY_MAX_PAGES = 10

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Entries returned by one listing when the caller does not cap it. */
const DEFAULT_MAX_ENTRIES = 256

/**
 * GitHub's `contents` listing, narrowed to the picker's entry shape.
 *
 * Anything that is not a named entry is skipped rather than rejected: a
 * listing is a browsing aid, and one odd row should not blank the directory.
 */
function toRepositoryEntries(
  payload: unknown,
  maxEntries: number,
): RepositoryEntry[] {
  if (!Array.isArray(payload)) return []
  const entries: RepositoryEntry[] = []
  for (const raw of payload.slice(0, maxEntries)) {
    if (!isPlainObject(raw) || typeof raw.path !== 'string') continue
    const entry: RepositoryEntry = {
      path: raw.path,
      kind: raw.type === 'dir' ? 'dir' : 'file',
    }
    if (typeof raw.size === 'number') entry.bytes = raw.size
    entries.push(entry)
  }
  return entries
}

/** GitHub sends numeric ids; the schema stores them as text. */
function externalId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return null
}

export function githubRepositoryExternalId(
  payload: Record<string, unknown>,
): string | null {
  const repository = payload.repository
  return isPlainObject(repository) ? externalId(repository.id) : null
}

export function githubInstallationExternalId(
  payload: Record<string, unknown>,
): string | null {
  const installation = payload.installation
  return isPlainObject(installation) ? externalId(installation.id) : null
}

/** Narrow GitHub's repository payload to the fields the picker needs. */
export function toGithubRepositorySummary(
  value: unknown,
): RepositorySummary | null {
  if (!isPlainObject(value)) return null
  const repo = value
  const fullName = repo.full_name
  if (typeof fullName !== 'string' || fullName.length === 0) return null
  return {
    id: externalId(repo.id) ?? '',
    fullName,
    defaultBranch:
      typeof repo.default_branch === 'string' ? repo.default_branch : null,
    private: repo.private === true,
    cloneUrl: typeof repo.clone_url === 'string' ? repo.clone_url : null,
  }
}

/** `GET /installation/repositories`, paginated. */
export async function listGithubInstallationRepositories(
  token: string,
): Promise<RepositorySummary[]> {
  const repositories: RepositorySummary[] = []

  for (let page = 1; page <= REPOSITORY_MAX_PAGES; page += 1) {
    const url = `${GITHUB_API_BASE}/installation/repositories` +
      `?per_page=${REPOSITORY_PAGE_SIZE}&page=${page}`
    const response = await fetch(url, { headers: githubApiHeaders(token, 'token') })
    if (!response.ok) {
      throw new GithubAppTokenError(
        `github repository listing failed (${response.status})`,
        response.status,
      )
    }
    const payload = (await response.json().catch(() => null)) as
      | { repositories?: unknown }
      | null
    const entries = Array.isArray(payload?.repositories) ? payload.repositories : []
    for (const entry of entries) {
      const summary = toGithubRepositorySummary(entry)
      if (summary) repositories.push(summary)
    }
    if (entries.length < REPOSITORY_PAGE_SIZE) break
  }

  return repositories
}

/** Percent-encode each path segment, keeping `/` as the separator. */
function encodePathSegments(path: string): string {
  return path.split('/').filter((seg) => seg.length > 0).map(encodeURIComponent)
    .join('/')
}

function networkFailureMessage(error: unknown): string {
  return `github request failed: ${
    error instanceof Error ? error.message : 'network error'
  }`
}

/**
 * A thrown provider error carries no HTTP status, so it reads as a reachability
 * problem and the caller falls back to the daemon. That is the right default:
 * the alternative is refusing a read the daemon could have served.
 */
function githubReadFailure(error: unknown): GitProviderFailure {
  return { failure: networkFailureMessage(error) }
}

/** Mint a short-lived installation token, or say why we cannot read. */
async function githubReadAuth(
  ctx: GitProviderContext,
  row: GitProviderSourceRow,
): Promise<
  { token: string } | GitProviderFailure | RepositoryReadUnsupported
> {
  // A GitHub source with no App installation cannot be read over the API at
  // all — the daemon clones it with the stored credential instead.
  if (!row.installationId) return { unsupported: true }
  if (!ctx.dataEncryptionSecrets) {
    return { failure: 'github app credentials are unreadable' }
  }
  try {
    const { token } = await mintGithubInstallationToken(
      ctx.db,
      ctx.dataEncryptionSecrets,
      row.installationId,
    )
    return { token }
  } catch (error) {
    return githubReadFailure(error)
  }
}

/**
 * One file at a pinned commit.
 *
 * `Accept: application/vnd.github.raw` returns the bytes directly, skipping the
 * base64 round-trip the JSON representation would need.
 */
async function readGithubFile(
  auth: { token: string },
  repositoryUrl: string,
  commitSha: string,
  path: string,
  maxBytes: number,
): Promise<RepositoryFileEntry | GitProviderFailure> {
  const parsed = parseRepositoryOwnerRepo(repositoryUrl)
  if (!parsed) return { failure: 'source repository url is not a github path' }
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${
    encodeURIComponent(parsed.repo)
  }/contents/${encodePathSegments(path)}?ref=${encodeURIComponent(commitSha)}`

  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        ...githubApiHeaders(auth.token, 'token'),
        Accept: 'application/vnd.github.raw',
      },
    })
  } catch (error) {
    return { failure: networkFailureMessage(error) }
  }

  // A missing file is an ANSWER, not a failure — it is what the wizard renders.
  if (response.status === 404) return { path, found: false, reason: 'not_found' }
  if (!response.ok) {
    return { failure: 'github file read failed', status: response.status }
  }
  // A directory comes back as a JSON array even under the raw media type.
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return { path, found: false, reason: 'not_a_file' }
  }

  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) {
    return { path, found: false, reason: 'too_large' }
  }
  // A NUL byte is the cheap, reliable binary signal; compose files never have
  // one, and returning binary as a lossy string would be worse than refusing.
  if (buffer.includes(0)) return { path, found: false, reason: 'binary' }

  return {
    path,
    found: true,
    content: new TextDecoder().decode(buffer),
    bytes: buffer.byteLength,
  }
}

/**
 * `GET /repos/{owner}/{repo}/commits/{ref}` → the resolved commit, with the
 * subject and author name the release surface shows.
 */
export async function resolveGithubCommit(
  token: string,
  repositoryUrl: string,
  ref: string,
): Promise<ResolvedSourceCommit> {
  const parsed = parseRepositoryOwnerRepo(repositoryUrl)
  if (!parsed) {
    throw new GithubAppTokenError(
      'source repository url is not a github repository path',
    )
  }
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${
    encodeURIComponent(parsed.repo)
  }/commits/${encodeURIComponent(ref)}`
  let response: Response
  try {
    response = await fetch(url, { headers: githubApiHeaders(token, 'token') })
  } catch (error) {
    throw new GithubAppTokenError(
      `github commit lookup failed: ${
        error instanceof Error ? error.message : 'network error'
      }`,
    )
  }
  if (!response.ok) {
    throw new GithubAppTokenError(
      `github commit lookup failed (${response.status})`,
      response.status,
    )
  }
  const payload = (await response.json().catch(() => null)) as
    | { sha?: unknown; commit?: { message?: unknown; author?: { name?: unknown } } }
    | null
  if (typeof payload?.sha !== 'string' || payload.sha.length === 0) {
    throw new GithubAppTokenError('github commit lookup returned no sha')
  }
  // The commit author (who wrote it), not the committer (who applied it) — the
  // release list answers "whose change is live", and a rebase or a squash-merge
  // rewrites the committer while leaving the author intact.
  const commitMessage = commitSubject(payload.commit?.message)
  const commitAuthor = trimCommitField(
    payload.commit?.author?.name,
    COMMIT_AUTHOR_MAX_CHARS,
  )
  return {
    commitSha: payload.sha,
    ...(commitMessage === undefined ? {} : { commitMessage }),
    ...(commitAuthor === undefined ? {} : { commitAuthor }),
  }
}

/** A `check_suite`-shaped object that has finished green. */
function isSuccessfulSuite(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) &&
    value.status === 'completed' &&
    value.conclusion === 'success'
}

/** `head_sha` from the run, else from the suite it belongs to. */
function checkHeadSha(
  subject: Record<string, unknown>,
  suite: Record<string, unknown> | null,
): string | null {
  if (isCommitSha(subject.head_sha)) return subject.head_sha
  if (suite && isCommitSha(suite.head_sha)) return suite.head_sha
  return null
}

/**
 * `check_suite` / `check_run` → the SHA whose checks are **all** green.
 *
 * `autoDeploy: 'checks_passed'` means "wait for CI", and only a `check_suite`
 * states that: a `check_run` is one job, and a repository with lint, unit, and
 * e2e jobs sends three of them. Releasing on the first success would deploy a
 * commit whose other jobs are still queued — or about to fail — which is exactly
 * the policy the setting exists to prevent.
 *
 * So a `check_run` is only honored when the suite it is nested in has itself
 * concluded successfully. GitHub sends the run with `check_run.check_suite`
 * carrying that suite's `status` / `conclusion`, and it is `completed` +
 * `success` only once every run in it finished green — which makes the last run
 * of a green suite (and only it) a valid release signal, and keeps the setting
 * working on installations that receive `check_run` but not `check_suite`.
 */
export function successfulCheckSha(
  event: string,
  payload: Record<string, unknown>,
): string | null {
  if (event === 'check_run') {
    const run = payload.check_run
    if (!isPlainObject(run)) return null
    if (run.status !== 'completed') return null
    if (run.conclusion !== 'success') return null
    // The enclosing suite is the all-checks-green signal, not this one run.
    if (!isSuccessfulSuite(run.check_suite)) return null
    return checkHeadSha(run, run.check_suite)
  }

  const suite = payload.check_suite
  if (!isSuccessfulSuite(suite)) return null
  return checkHeadSha(suite, null)
}

export const githubProvider: GitProvider = {
  provider: 'github',

  async listRepositories(
    ctx: GitProviderContext,
    installationId: string,
  ): Promise<RepositorySummary[]> {
    if (!ctx.dataEncryptionSecrets) {
      throw new GithubAppTokenError('github app credentials are unreadable')
    }
    // Minted per request, used once, and discarded — never persisted.
    const { token } = await mintGithubInstallationToken(
      ctx.db,
      ctx.dataEncryptionSecrets,
      installationId,
    )
    return await listGithubInstallationRepositories(token)
  },

  async readRepositoryFiles(
    ctx: GitProviderContext,
    params: ReadRepositoryFilesParams,
  ): Promise<
    RepositoryFileSet | GitProviderFailure | RepositoryReadUnsupported
  > {
    const auth = await githubReadAuth(ctx, params.row)
    if ('unsupported' in auth || 'failure' in auth) return auth

    // Resolve the commit FIRST so every file in one set comes from one commit.
    // Reading by branch name would let a push land mid-wizard and produce a
    // torn view — a compose file from one commit, a package.json from another.
    let commitSha: string
    try {
      commitSha =
        (await resolveGithubCommit(auth.token, params.row.repositoryUrl, params.ref))
          .commitSha
    } catch (error) {
      return githubReadFailure(error)
    }

    const maxBytes = params.maxBytesPerFile ?? MAX_REPOSITORY_FILE_BYTES
    const files: RepositoryFileEntry[] = []
    for (const path of params.paths.slice(0, MAX_REPOSITORY_READ_PATHS)) {
      const entry = await readGithubFile(
        auth,
        params.row.repositoryUrl,
        commitSha,
        path,
        maxBytes,
      )
      // A transport failure aborts the whole read: reporting the remaining
      // paths as `not_found` would be a lie the caller cannot detect.
      if (isGitProviderFailure(entry)) return entry
      files.push(entry)
    }
    return { commitSha, files }
  },

  async listRepositoryEntries(
    ctx: GitProviderContext,
    params: ListRepositoryEntriesParams,
  ): Promise<
    | { commitSha: string; entries: RepositoryEntry[] }
    | GitProviderFailure
    | RepositoryReadUnsupported
  > {
    const auth = await githubReadAuth(ctx, params.row)
    if ('unsupported' in auth || 'failure' in auth) return auth

    let commitSha: string
    try {
      commitSha =
        (await resolveGithubCommit(auth.token, params.row.repositoryUrl, params.ref))
          .commitSha
    } catch (error) {
      return githubReadFailure(error)
    }

    const parsed = parseRepositoryOwnerRepo(params.row.repositoryUrl)
    if (!parsed) return { failure: 'source repository url is not a github path' }
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(parsed.owner)}/${
      encodeURIComponent(parsed.repo)
    }/contents/${encodePathSegments(params.path)}?ref=${encodeURIComponent(commitSha)}`

    let response: Response
    try {
      response = await fetch(url, {
        headers: githubApiHeaders(auth.token, 'token'),
      })
    } catch (error) {
      // No `status`: the fetch never got an HTTP answer, so this is a
      // reachability problem the daemon may not have.
      return { failure: networkFailureMessage(error) }
    }
    if (response.status === 404) return { commitSha, entries: [] }
    if (!response.ok) {
      return { failure: `github listing failed`, status: response.status }
    }
    const payload = (await response.json().catch(() => null)) as unknown
    return {
      commitSha,
      entries: toRepositoryEntries(payload, params.maxEntries ?? DEFAULT_MAX_ENTRIES),
    }
  },

  async prepareClone(
    ctx: GitProviderContext,
    params: PrepareCloneParams,
  ): Promise<PreparedClone | GitProviderFailure> {
    const { row, ref } = params
    // Preview never mints a token — shape only, ref as the placeholder.
    if (!params.needsCredential) {
      return { commit: { commitSha: params.requestedCommitSha ?? ref } }
    }
    if (!row.installationId) {
      return { failure: 'github source has no app installation' }
    }
    if (!ctx.dataEncryptionSecrets) {
      return { failure: 'github app credentials are unreadable' }
    }

    try {
      // Minted here, sealed straight into the payload by the caller, never
      // persisted.
      const { token } = await mintGithubInstallationToken(
        ctx.db,
        ctx.dataEncryptionSecrets,
        row.installationId,
      )
      // A webhook already knows the head SHA, but not its subject or author, so
      // the commit is resolved either way — pinned to the SHA the trigger named
      // rather than to the (possibly already advanced) ref. When the SHA is
      // already known the lookup is *decoration*: a provider hiccup there must
      // not fail a deploy that has everything it needs to build, so it degrades
      // to the bare SHA instead of raising. Without a SHA the lookup is
      // load-bearing and its failure is a real prepare error.
      const commit = params.requestedCommitSha === undefined
        ? await resolveGithubCommit(token, row.repositoryUrl, ref)
        : await resolveGithubCommit(
          token,
          row.repositoryUrl,
          params.requestedCommitSha,
        ).catch(() => ({ commitSha: params.requestedCommitSha as string }))
      return {
        commit: {
          ...commit,
          commitSha: params.requestedCommitSha ?? commit.commitSha,
        },
        minted: { secret: token, kind: 'token' },
      }
    } catch (error) {
      if (error instanceof GithubAppTokenError) {
        return {
          failure: error.message,
          ...(error.status === undefined ? {} : { status: error.status }),
        }
      }
      throw error
    }
  },

  async verifyWebhook(
    secret: string | null | undefined,
    rawBody: Uint8Array,
    headers: WebhookHeaders,
  ): Promise<boolean> {
    return await verifyGithubWebhookSignature(
      secret,
      rawBody,
      headers.get(GITHUB_SIGNATURE_HEADER),
    )
  },

  parsePush(payload: Record<string, unknown>): ProviderPushEvent | null {
    const ref = typeof payload.ref === 'string' ? payload.ref : null
    const branch = branchFromGitRef(ref)
    if (!ref || !branch) return null

    const installation = githubInstallationExternalId(payload)
    const repository = githubRepositoryExternalId(payload)
    if (!installation || !repository) return null

    // Deleting a branch is delivered as a push whose `after` is the all-zero SHA
    // (`isCommitSha` rejects it) with `deleted: true`. There is no head to
    // build, so it is not a deploy trigger for any `autoDeploy` mode.
    const deleted = payload.deleted === true || !isCommitSha(payload.after)
    return {
      externalInstallationId: installation,
      repositoryExternalId: repository,
      ref,
      branch,
      commitSha: deleted ? null : (payload.after as string),
      deleted,
    }
  },

  parseCheck(
    event: string,
    payload: Record<string, unknown>,
  ): ProviderCheckEvent | null {
    const commitSha = successfulCheckSha(event, payload)
    if (!commitSha) return null
    const installation = githubInstallationExternalId(payload)
    const repository = githubRepositoryExternalId(payload)
    if (!installation || !repository) return null
    return {
      externalInstallationId: installation,
      repositoryExternalId: repository,
      commitSha,
    }
  },
}
