/**
 * Generic SSH / HTTPS Git (`provider: 'git'`) as a {@link GitProvider}.
 *
 * The degenerate case, and deliberately so. There is no API to list
 * repositories through, no remote SHA resolution yet (the ref passes through
 * as `commitSha` and the daemon resolves it on clone — an `ls-remote` phase
 * replaces that), no credential to mint (the source's stored `credential` row
 * *is* the deploy key), and no webhook surface to authenticate.
 *
 * Writing it as an implementation rather than as the `else` of a two-way branch
 * is what lets `deploy-sources.ts` dispatch once instead of testing
 * `row.provider` in three places.
 */

import type {
  RepositoryReadUnsupported,
  GitProvider,
  GitProviderContext,
  ListRepositoryEntriesParams,
  PreparedClone,
  PrepareCloneParams,
  ProviderCheckEvent,
  ProviderPushEvent,
  ReadRepositoryFilesParams,
  RepositorySummary,
  WebhookHeaders,
} from './git-provider.ts'

export const genericGitProvider: GitProvider = {
  provider: 'git',

  listRepositories(
    _ctx: GitProviderContext,
    _installationId: string,
  ): Promise<RepositorySummary[]> {
    // No provider API: a generic source is registered by pasting its clone URL.
    return Promise.resolve([])
  },

  prepareClone(
    _ctx: GitProviderContext,
    params: PrepareCloneParams,
  ): Promise<PreparedClone> {
    // No minted secret: the caller falls back to `source.secretId`, which is
    // the only credential a generic source has.
    return Promise.resolve({
      commit: { commitSha: params.requestedCommitSha ?? params.ref },
    })
  },

  verifyWebhook(
    _secret: string | null | undefined,
    _rawBody: Uint8Array,
    _headers: WebhookHeaders,
  ): Promise<boolean> {
    // There is no generic-git webhook surface; nothing may authenticate as one.
    return Promise.resolve(false)
  },

  parsePush(_payload: Record<string, unknown>): ProviderPushEvent | null {
    return null
  },

  parseCheck(
    _event: string,
    _payload: Record<string, unknown>,
  ): ProviderCheckEvent | null {
    return null
  },

  /**
   * A bare git remote has no read API at all — only the wire protocol, which
   * needs a clone. `unsupported` routes the caller to the daemon, which can.
   */
  readRepositoryFiles(
    _ctx: GitProviderContext,
    _params: ReadRepositoryFilesParams,
  ): Promise<RepositoryReadUnsupported> {
    return Promise.resolve({ unsupported: true })
  },

  listRepositoryEntries(
    _ctx: GitProviderContext,
    _params: ListRepositoryEntriesParams,
  ): Promise<RepositoryReadUnsupported> {
    return Promise.resolve({ unsupported: true })
  },
}
