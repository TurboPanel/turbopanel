/**
 * Clone-URL and commit-metadata helpers shared by every Git provider.
 *
 * These used to live in `src/client/environments/deploy-sources.ts`, where they
 * were reachable only from deploy-prepare. Both provider implementations need
 * them now (a GitLab project path is parsed exactly like a GitHub one, and a
 * commit subject is capped the same way whoever resolved it), so they sit in
 * `lib/git` with the rest of the provider vocabulary. `deploy-sources.ts`
 * re-exports them under their original names.
 *
 * Web APIs only — no Node built-ins — so the module stays reachable from
 * `src/workers.ts` (`pnpm check:workers-bundle`).
 */

/** `git@host:owner/repo.git` — the scp-like form git accepts. */
const SCP_LIKE_SSH_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/

/**
 * Is this clone URL an SSH transport?
 *
 * The answer decides the credential *shape* the daemon receives: an `ssh://…`
 * or `git@host:path` clone authenticates with a private key it must install as
 * an identity file, not with a password an askpass helper can print. Same rule
 * `validateRepositoryUrl` applies when it accepts the URL in the first place.
 */
export function isSshCloneUrl(cloneUrl: string): boolean {
  return cloneUrl.startsWith('ssh://') || SCP_LIKE_SSH_RE.test(cloneUrl)
}

/**
 * One repository, one string: the canonical clone URL.
 *
 * `repository` rows are deduplicated per organization by
 * `UNIQUE (organization_id, repository_url)`, and a unique index can only do
 * that job when equal repositories serialize equally. Without this,
 * `https://github.com/acme/app` and `https://github.com/acme/app.git` (or a
 * host typed with a capital letter, or a stray trailing slash) each mint their
 * own row — and `auto_deploy` / `default_branch` silently diverge between them
 * while one push fans out to both.
 *
 * The canonical form is the **`.git` clone URL** — the address git itself
 * resolves — with the case-insensitive parts lower-cased:
 *
 * - scheme and host lower-cased (path case is preserved: hosts other than
 *   GitHub/GitLab may treat it as significant)
 * - trailing slashes dropped, query/fragment dropped (git ignores both)
 * - exactly one `.git` suffix on a non-empty path
 * - scp-syntax (`git@host:owner/repo`) keeps its shape — it is a different
 *   transport, not a spelling of the https URL — but gets the same host
 *   lower-casing and `.git` suffix.
 *
 * Applied at the write boundary (`validateRepositoryUrl`), never at read time,
 * so the stored column *is* the canonical value the unique index compares.
 * Anything unparseable is returned trimmed — validation rejects it separately.
 */
export function canonicalizeRepositoryUrl(raw: string): string {
  const url = raw.trim()

  let parsed: URL | null = null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    try {
      parsed = new URL(url)
    } catch {
      return url
    }
  }

  if (parsed) {
    // URL already lower-cases protocol and hostname on parse.
    const path = ensureGitSuffix(parsed.pathname.replace(/\/+$/, ''))
    if (path.length === 0) return url
    const port = parsed.port ? `:${parsed.port}` : ''
    const user = parsed.username ? `${parsed.username}@` : ''
    return `${parsed.protocol}//${user}${parsed.hostname}${port}${path}`
  }

  // scp-syntax: `user@host:path`.
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(\S+)$/.exec(url)
  if (!scp) return url
  const [, user, host, rawPath] = scp
  const path = ensureGitSuffix(rawPath.replace(/\/+$/, ''))
  if (path.length === 0) return url
  return `${user}@${host.toLowerCase()}:${path}`
}

function ensureGitSuffix(path: string): string {
  if (path.length === 0) return path
  return path.endsWith('.git') ? path : `${path}.git`
}

/**
 * `https://host/owner/repo(.git)` → `{ owner, repo }`.
 * `null` when the URL is not a two-segment repository path.
 *
 * Works for GitHub and for a top-level GitLab project alike; a GitLab project
 * nested in subgroups needs its full encoded path instead, which
 * {@link repositoryPathFromCloneUrl} answers.
 */
export function parseRepositoryOwnerRepo(
  repositoryUrl: string,
): { owner: string; repo: string } | null {
  const segments = repositoryPathSegments(repositoryUrl)
  if (segments.length < 2) return null
  const owner = segments.at(-2)!
  const repo = segments.at(-1)!.replace(/\.git$/, '')
  if (owner.length === 0 || repo.length === 0) return null
  return { owner, repo }
}

/**
 * Full repository path (`group/subgroup/project`), `.git` stripped.
 *
 * GitLab addresses a project by its **whole** namespace path, not by
 * `owner/repo` — a project can sit arbitrarily deep in subgroups — so its API
 * client percent-encodes this string as the project id.
 */
export function repositoryPathFromCloneUrl(
  repositoryUrl: string,
): string | null {
  const segments = repositoryPathSegments(repositoryUrl)
  if (segments.length < 2) return null
  const last = segments.at(-1)!.replace(/\.git$/, '')
  if (last.length === 0) return null
  return [...segments.slice(0, -1), last].join('/')
}

function repositoryPathSegments(repositoryUrl: string): string[] {
  let path: string
  try {
    path = new URL(repositoryUrl).pathname
  } catch {
    // scp-syntax (`git@host:owner/repo.git`) — take the part after `:`.
    const colon = repositoryUrl.indexOf(':')
    if (colon === -1) return []
    path = repositoryUrl.slice(colon + 1)
  }
  return path.split('/').filter((segment) => segment.length > 0)
}

/** First line of a commit message — the subject operators actually scan. */
export const COMMIT_MESSAGE_MAX_CHARS = 300
export const COMMIT_AUTHOR_MAX_CHARS = 200

export function trimCommitField(
  value: unknown,
  maxChars: number,
): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
}

/**
 * The commit *subject* (everything before the first blank line collapses to the
 * first line), capped.
 *
 * The release list renders one line per release; a full commit body would blow
 * the row open and is already a click away in the repository. Capping here — at
 * the only place the message enters the system — means every durable copy of it
 * (`command.context`, `deployment.json`, the release manifest) is bounded by
 * construction rather than by each writer remembering to bound it.
 */
export function commitSubject(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined
  const [firstLine] = message.split('\n')
  return trimCommitField(firstLine, COMMIT_MESSAGE_MAX_CHARS)
}

/** Git ref (`refs/heads/main`) → branch name, or `null` for a non-branch ref. */
export function branchFromGitRef(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null
  const prefix = 'refs/heads/'
  if (!ref.startsWith(prefix)) return null
  const branch = ref.slice(prefix.length)
  return branch.length > 0 ? branch : null
}

/** Commit SHAs are 40 hex chars; the all-zero SHA marks a branch delete. */
const SHA_RE = /^[0-9a-f]{40}$/i
export const NULL_COMMIT_SHA = '0000000000000000000000000000000000000000'

export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_RE.test(value) && value !== NULL_COMMIT_SHA
}
