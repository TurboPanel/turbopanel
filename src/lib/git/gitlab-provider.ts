/**
 * GitLab as a {@link GitProvider}.
 *
 * Three things differ from GitHub, and they are the reason the interface exists
 * rather than a second copy of the GitHub code:
 *
 *  1. **No per-repository installation.** GitLab has no App install; the
 *     operator connects an account or group over OAuth once, and every project
 *     that connection can read is available. A `gitProviderInstallation` row
 *     with `provider: 'gitlab'` records that connection, and the OAuth token
 *     pair lives sealed on it (`./gitlab-oauth-token.ts`).
 *  2. **Deliveries name no connection.** A GitLab webhook payload identifies
 *     the *project*, never the OAuth connection, so {@link GitProvider.parsePush}
 *     reports `externalInstallationId: null` and the trigger resolver treats
 *     every live GitLab connection as a candidate, disambiguated by project id.
 *  3. **Two clone lanes.** A source may connect through the OAuth connection
 *     (an access token is minted per deploy, exactly like GitHub) *or* through
 *     a generated read-only **deploy key** held in `credential` — the same lane
 *     `provider: 'git'` already uses. The deploy-key lane mints nothing here;
 *     `prepareClone` simply returns no `minted` secret and the caller reseals
 *     the stored key.
 *
 * On the wire the OAuth access token travels as `credentialKind: 'token'` with
 * `credentialUsername: 'oauth2'`. The username is load-bearing here and is the
 * one place GitLab differs from GitHub on the credential wire: GitLab accepts
 * an OAuth access token over HTTPS **only** when the basic-auth user is
 * literally `oauth2`, where GitHub ignores the user for an installation token.
 * It is stated as data on the payload rather than as a branch on the host, so
 * deploy-prepare and the daemon keep carrying one opaque username/password pair
 * and never learn that GitLab exists.
 */

import type {
  GitProvider,
  GitProviderContext,
  GitProviderFailure,
  PreparedClone,
  PrepareCloneParams,
  ProviderCheckEvent,
  ProviderInstallationEvent,
  ProviderPushEvent,
  RepositorySummary,
  WebhookHeaders,
} from './git-provider.ts'
import { branchFromGitRef, isCommitSha } from './clone-url.ts'
import {
  GitlabApiError,
  gitlabProjectId,
  listGitlabProjects,
  resolveGitlabCommit,
} from './gitlab-api.ts'
import { getGitlabOauthConfig } from './gitlab-oauth-config.ts'
import {
  GitlabOauthTokenError,
  mintGitlabAccessToken,
} from './gitlab-oauth-token.ts'
import {
  GITLAB_TOKEN_HEADER,
  verifyGitlabWebhookToken,
} from './gitlab-webhook.ts'

export { fetchGitlabAccount } from './gitlab-api.ts'

/**
 * HTTPS basic-auth user for an OAuth access token.
 *
 * GitLab's documented pairing is `oauth2:<access-token>`; the token alone,
 * under any other user, is rejected at authentication. Carried on the deploy
 * payload as `credentialUsername` so the daemon answers git's `Username` prompt
 * with it without knowing why.
 */
export const GITLAB_OAUTH_HTTPS_USERNAME = 'oauth2'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** GitLab sends numeric ids; the schema stores them as text. */
function externalId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return null
}

/**
 * Project id from a delivery.
 *
 * GitLab puts it at the top level (`project_id`) on a push and inside
 * `project.id` on the pipeline events, and both are present on most payloads —
 * read whichever answers.
 */
export function gitlabRepositoryExternalId(
  payload: Record<string, unknown>,
): string | null {
  const direct = externalId(payload.project_id)
  if (direct) return direct
  const project = payload.project
  return isPlainObject(project) ? externalId(project.id) : null
}

/**
 * `Push Hook` → the trigger tuple.
 *
 * A branch delete arrives as a push whose `after` is the all-zero SHA with a
 * `null` `checkout_sha`, the same shape GitHub uses, so it is reported as
 * `deleted` and never becomes a deploy trigger.
 */
export function parseGitlabPush(
  payload: Record<string, unknown>,
): ProviderPushEvent | null {
  if (payload.object_kind !== undefined && payload.object_kind !== 'push') {
    return null
  }
  const ref = typeof payload.ref === 'string' ? payload.ref : null
  const branch = branchFromGitRef(ref)
  if (!ref || !branch) return null

  const repository = gitlabRepositoryExternalId(payload)
  if (!repository) return null

  const afterSha = isCommitSha(payload.after) ? payload.after : null
  const head = isCommitSha(payload.checkout_sha) ? payload.checkout_sha : afterSha
  const deleted = head === null

  return {
    // GitLab deliveries name the project, never the OAuth connection.
    externalInstallationId: null,
    repositoryExternalId: repository,
    ref,
    branch,
    commitSha: head,
    deleted,
  }
}

/**
 * `Pipeline Hook` → the SHA whose CI is green.
 *
 * The pipeline is GitLab's suite-level signal, so it is the exact analogue of
 * GitHub's `check_suite`: one pipeline covers every job in the ref, and only a
 * pipeline that finished `success` means "all checks passed". A `Job Hook`
 * describes one job and is deliberately not honored — releasing on it would
 * deploy a commit whose remaining jobs are still running, which is the policy
 * `autoDeploy: 'checks_passed'` exists to prevent.
 */
export function parseGitlabPipeline(
  payload: Record<string, unknown>,
): ProviderCheckEvent | null {
  if (payload.object_kind !== 'pipeline') return null
  const attributes = payload.object_attributes
  if (!isPlainObject(attributes)) return null
  if (attributes.status !== 'success') return null
  if (!isCommitSha(attributes.sha)) return null

  const repository = gitlabRepositoryExternalId(payload)
  if (!repository) return null

  return {
    externalInstallationId: null,
    repositoryExternalId: repository,
    commitSha: attributes.sha,
  }
}

/**
 * GitLab has no `installation` lifecycle webhook — a connection ends when the
 * operator revokes the OAuth grant, which surfaces as a failing refresh rather
 * than as a delivery. Exported for symmetry with GitHub so the ingress route
 * can state that explicitly instead of silently having no case for it.
 */
export function parseGitlabInstallationEvent(
  _payload: Record<string, unknown>,
): ProviderInstallationEvent | null {
  return null
}

export const gitlabProvider: GitProvider = {
  provider: 'gitlab',

  async listRepositories(
    ctx: GitProviderContext,
    installationId: string,
  ): Promise<RepositorySummary[]> {
    if (!ctx.dataEncryptionSecrets) {
      throw new GitlabOauthTokenError('gitlab oauth credentials are unreadable')
    }
    const config = await getGitlabOauthConfig(ctx.db, ctx.dataEncryptionSecrets)
    if (!config) {
      throw new GitlabOauthTokenError('gitlab oauth application is not configured')
    }
    const { token } = await mintGitlabAccessToken(
      ctx.db,
      ctx.dataEncryptionSecrets,
      installationId,
    )
    return await listGitlabProjects(config.baseUrl, token)
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

    // Deploy-key lane: no OAuth connection, so nothing to mint and nothing to
    // resolve against. The stored `credential` row clones it, exactly as for
    // `provider: 'git'`.
    if (!row.installationId) {
      if (!row.credentialId) {
        return {
          failure: 'gitlab source has neither an oauth connection nor a deploy key',
        }
      }
      return { commit: { commitSha: params.requestedCommitSha ?? ref } }
    }

    if (!ctx.dataEncryptionSecrets) {
      return { failure: 'gitlab oauth credentials are unreadable' }
    }

    try {
      const config = await getGitlabOauthConfig(ctx.db, ctx.dataEncryptionSecrets)
      if (!config) {
        return { failure: 'gitlab oauth application is not configured' }
      }
      // Minted (and, when the pair had rotated, written back) here; sealed
      // straight into the payload by the caller and never persisted onward.
      const { token } = await mintGitlabAccessToken(
        ctx.db,
        ctx.dataEncryptionSecrets,
        row.installationId,
      )

      const projectId = gitlabProjectId(null, row.repositoryUrl)
      if (!projectId) {
        return { failure: 'source repository url is not a gitlab project path' }
      }

      // Same rule as GitHub: without a known SHA the lookup is load-bearing;
      // with one it is decoration for the release surface and must not fail a
      // deploy that already has everything it needs to build.
      const commit = params.requestedCommitSha === undefined
        ? await resolveGitlabCommit(config.baseUrl, token, projectId, ref)
        : await resolveGitlabCommit(
          config.baseUrl,
          token,
          projectId,
          params.requestedCommitSha,
        ).catch(() => ({ commitSha: params.requestedCommitSha as string }))

      return {
        commit: {
          ...commit,
          commitSha: params.requestedCommitSha ?? commit.commitSha,
        },
        // `oauth2` is not a nicety: GitLab rejects an OAuth access token
        // presented under any other basic-auth user, so the username travels
        // with the secret instead of being defaulted on the host.
        minted: { secret: token, kind: 'token', username: GITLAB_OAUTH_HTTPS_USERNAME },
      }
    } catch (error) {
      if (error instanceof GitlabOauthTokenError || error instanceof GitlabApiError) {
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
    _rawBody: Uint8Array,
    headers: WebhookHeaders,
  ): Promise<boolean> {
    // GitLab does not sign the body — possession of the shared token is the
    // whole credential. See `./gitlab-webhook.ts`.
    return await verifyGitlabWebhookToken(secret, headers.get(GITLAB_TOKEN_HEADER))
  },

  parsePush(payload: Record<string, unknown>): ProviderPushEvent | null {
    return parseGitlabPush(payload)
  },

  parseCheck(
    _event: string,
    payload: Record<string, unknown>,
  ): ProviderCheckEvent | null {
    return parseGitlabPipeline(payload)
  },
}
