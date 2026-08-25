/**
 * Minimal GitLab REST v4 client (Workers-safe).
 *
 * Same discipline as the GitHub calls in `./github-app-token.ts`: bare `fetch`
 * with explicit error mapping and no third-party HTTP client. Only the three
 * things TurboPanel actually asks GitLab for are here — who connected, which
 * projects they can see, and what commit a ref points at.
 *
 * **Base URL is configuration, not a constant.** Self-managed GitLab is the
 * common case for the audience that wants GitLab at all, so every call takes
 * the instance root from `getGitlabOauthConfig().baseUrl` rather than
 * hardcoding `https://gitlab.com`.
 *
 * **Project ids are full namespace paths.** GitLab addresses a project by its
 * numeric id *or* by its whole percent-encoded path
 * (`group%2Fsubgroup%2Fproject`) — not by `owner/repo`, because projects nest
 * arbitrarily deep in subgroups. Callers hold the numeric id
 * (`source.repositoryExternalId`) whenever they have one and fall back to the
 * path derived from the clone URL.
 */

import type { RepositorySummary, ResolvedSourceCommit } from './git-provider.ts'
import {
  commitSubject,
  COMMIT_AUTHOR_MAX_CHARS,
  repositoryPathFromCloneUrl,
  trimCommitField,
} from './clone-url.ts'

export class GitlabApiError extends Error {
  /** HTTP status from GitLab, when the failure came from the API. */
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GitlabApiError'
    this.status = status
  }
}

/** GitLab paginates; walk a bounded number of pages like the GitHub picker. */
const PROJECT_PAGE_SIZE = 100
const PROJECT_MAX_PAGES = 10

export function gitlabApiBase(baseUrl: string): string {
  return `${baseUrl.replace(/(?<!\/)\/+$/, '')}/api/v4`
}

export function gitlabApiHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  }
}

async function readGitlabError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body) return `gitlab request failed (${response.status})`
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown }
    for (const field of [parsed.message, parsed.error]) {
      if (typeof field === 'string' && field.length > 0) {
        return `gitlab request failed (${response.status}): ${field}`
      }
    }
  } catch {
    // Non-JSON error body — fall through to the status-only message.
  }
  return `gitlab request failed (${response.status})`
}

async function gitlabGet(
  baseUrl: string,
  token: string,
  path: string,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${gitlabApiBase(baseUrl)}${path}`, {
      headers: gitlabApiHeaders(token),
    })
  } catch (error) {
    throw new GitlabApiError(
      `gitlab request failed: ${
        error instanceof Error ? error.message : 'network error'
      }`,
    )
  }
  if (!response.ok) {
    throw new GitlabApiError(await readGitlabError(response), response.status)
  }
  return await response.json().catch(() => null)
}

/**
 * Raw-bytes sibling of {@link gitlabGet}.
 *
 * The JSON helper decodes; file contents must not be. Returns the response so
 * the caller can distinguish 404 (a missing file, which is an answer) from a
 * transport failure (which is not).
 */
export async function gitlabGetRaw(
  baseUrl: string,
  token: string,
  path: string,
): Promise<Response> {
  try {
    return await fetch(`${gitlabApiBase(baseUrl)}${path}`, {
      headers: gitlabApiHeaders(token),
    })
  } catch (error) {
    throw new GitlabApiError(
      `gitlab request failed: ${
        error instanceof Error ? error.message : 'network error'
      }`,
    )
  }
}

/** JSON GET that surfaces the response instead of throwing on 404. */
export async function gitlabGetJson(
  baseUrl: string,
  token: string,
  path: string,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number }> {
  const response = await gitlabGetRaw(baseUrl, token, path)
  if (!response.ok) return { ok: false, status: response.status }
  return { ok: true, payload: await response.json().catch(() => null) }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow GitLab's project payload to the fields the picker needs. */
export function toGitlabRepositorySummary(
  value: unknown,
): RepositorySummary | null {
  if (!isPlainObject(value)) return null
  const project = value
  const fullName = typeof project.path_with_namespace === 'string'
    ? project.path_with_namespace
    : null
  if (!fullName || fullName.length === 0) return null
  return {
    id: typeof project.id === 'number' || typeof project.id === 'string'
      ? String(project.id)
      : '',
    fullName,
    defaultBranch: typeof project.default_branch === 'string'
      ? project.default_branch
      : null,
    // GitLab reports `visibility`, not a boolean: anything other than `public`
    // needs a credential to clone, which is what the picker's badge means.
    private: project.visibility !== 'public',
    cloneUrl: typeof project.http_url_to_repo === 'string'
      ? project.http_url_to_repo
      : null,
  }
}

/**
 * Projects the connected token can read.
 *
 * `min_access_level=20` (Reporter) is GitLab's actual floor for reading a
 * repository — a Reporter can browse and clone the code, which is everything a
 * deploy needs. Filtering at Developer instead would hide every repository the
 * organization deliberately granted read-only, which is a supported way to
 * connect a source, not a misconfiguration.
 *
 * `membership=true` still applies: the picker offers what this connection is a
 * member of, not every public project on the instance.
 */
export async function listGitlabProjects(
  baseUrl: string,
  token: string,
): Promise<RepositorySummary[]> {
  const projects: RepositorySummary[] = []

  for (let page = 1; page <= PROJECT_MAX_PAGES; page += 1) {
    const payload = await gitlabGet(
      baseUrl,
      token,
      `/projects?membership=true&min_access_level=20&order_by=last_activity_at` +
        `&per_page=${PROJECT_PAGE_SIZE}&page=${page}`,
    )
    const entries = Array.isArray(payload) ? payload : []
    for (const entry of entries) {
      const summary = toGitlabRepositorySummary(entry)
      if (summary) projects.push(summary)
    }
    if (entries.length < PROJECT_PAGE_SIZE) break
  }

  return projects
}

/** The connected account, for the installation row's display fields. */
export async function fetchGitlabAccount(
  baseUrl: string,
  token: string,
): Promise<{ externalId: string | null; login: string | null }> {
  try {
    const payload = await gitlabGet(baseUrl, token, '/user')
    if (!isPlainObject(payload)) return { externalId: null, login: null }
    const id = payload.id
    return {
      externalId: typeof id === 'number' || typeof id === 'string'
        ? String(id)
        : null,
      login: typeof payload.username === 'string' ? payload.username : null,
    }
  } catch {
    return { externalId: null, login: null }
  }
}

/**
 * The project id to address one source with.
 *
 * Prefers the recorded numeric id — a project can be renamed or moved between
 * groups, and only the id survives that — and falls back to the namespace path
 * parsed out of the clone URL for sources registered by pasting a URL.
 */
export function gitlabProjectId(
  repositoryExternalId: string | null,
  repositoryUrl: string,
): string | null {
  const recorded = repositoryExternalId?.trim()
  if (recorded && recorded.length > 0) return recorded
  return repositoryPathFromCloneUrl(repositoryUrl)
}

/**
 * `GET /projects/{id}/repository/commits/{ref}` → the resolved commit, with the
 * subject and author name the release surface shows.
 */
export async function resolveGitlabCommit(
  baseUrl: string,
  token: string,
  projectId: string,
  ref: string,
): Promise<ResolvedSourceCommit> {
  const payload = await gitlabGet(
    baseUrl,
    token,
    `/projects/${encodeURIComponent(projectId)}/repository/commits/${
      encodeURIComponent(ref)
    }`,
  )
  if (!isPlainObject(payload)) {
    throw new GitlabApiError('gitlab commit lookup returned no commit')
  }
  const sha = payload.id
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new GitlabApiError('gitlab commit lookup returned no sha')
  }
  // `title` is already the subject; `message` is the full body. Prefer the
  // title and cap either way, same bound every other writer of this field uses.
  const commitMessage = commitSubject(
    typeof payload.title === 'string' ? payload.title : payload.message,
  )
  const commitAuthor = trimCommitField(
    payload.author_name,
    COMMIT_AUTHOR_MAX_CHARS,
  )
  return {
    commitSha: sha,
    ...(commitMessage === undefined ? {} : { commitMessage }),
    ...(commitAuthor === undefined ? {} : { commitAuthor }),
  }
}
