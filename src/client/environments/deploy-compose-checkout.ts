/**
 * The repository checkout of a Git Compose project, as `composeCheckout` on an
 * `environment.deploy` payload.
 *
 * A project that follows its repository's compose file reads that file at one
 * commit (`deploy-tracked-base.ts`). Its relative paths (`build: ./vpn`,
 * `./conf:/etc/x`, `env_file: ./app.env`) mean files of the same repository at
 * the same commit, so the host needs that tree. This module builds the entry
 * that tells the daemon what to check out: the clone URL, the exact commit the
 * file was read from, where the file sits in the repository, and the clone
 * credential sealed to that daemon on the same lane `sourceMaterial[]` uses.
 *
 * Which commit: always the one recorded in the Base (`composeBase.commitSha`),
 * never a fresh read of the branch, so the files and the compose document come
 * from one commit even if a push lands between the two. A rollback checks out
 * the commit its recorded Base names.
 *
 * Preview carries none of it: it sends nothing to a host and must not mint or
 * seal a credential.
 */
import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { repository } from '../../db/schema.ts'
import type { ComposeBaseRecord } from '../../features/projects/project-options.ts'
import type { EnvironmentDeployComposeCheckout } from '../../contracts/commands/schemas.ts'
import { definedFields } from '../../lib/optional-fields.ts'
import {
  resolveDaemonRecipient,
  resolveSourceCommitAndCredential,
  type DeploySourcePrepareError,
  type SourceRow,
} from './deploy-sources.ts'

export type DeployComposeCheckoutParams = {
  mode: 'deploy' | 'preview'
  organizationId: string
  serverId: string
  /** The Base this deploy used; `null` when the project does not follow a file. */
  composeBase: ComposeBaseRecord | null
}

/**
 * The checkout entry for one server, `undefined` when there is nothing to check
 * out (no followed file, or a preview), or the reason it cannot be resolved.
 */
export async function resolveDeployComposeCheckout(
  c: Context<AppEnv>,
  db: Db,
  params: DeployComposeCheckoutParams
): Promise<EnvironmentDeployComposeCheckout | DeploySourcePrepareError | Response | undefined> {
  const { composeBase } = params
  if (composeBase === null || params.mode === 'preview') return undefined

  const [row] = await db
    .select({
      id: repository.id,
      provider: repository.provider,
      repositoryUrl: repository.repositoryUrl,
      defaultBranch: repository.defaultBranch,
      subdirectory: repository.subdirectory,
      connectionId: repository.connectionId,
      secretId: repository.secretId,
    })
    .from(repository)
    .where(
      and(
        eq(repository.organizationId, params.organizationId),
        eq(repository.id, composeBase.sourceId)
      )
    )
    .limit(1)
  if (!row) {
    return {
      kind: 'source_ref_unresolved',
      composeServiceName: composeBase.path,
      sourceId: composeBase.sourceId,
      ref: composeBase.ref,
      message: 'repository not found in this organization',
    }
  }

  const recipient = await resolveDaemonRecipient(db, params.serverId)
  if (recipient instanceof Response) return recipient

  const resolved = await resolveSourceCommitAndCredential(c, db, {
    composeServiceName: composeBase.path,
    row: row satisfies SourceRow,
    ref: composeBase.ref,
    sealForDaemon: true,
    recipient,
    requestedCommitSha: composeBase.commitSha,
  })
  if (resolved instanceof Response) return resolved
  if ('kind' in resolved) return resolved

  return definedFields({
    sourceId: row.id,
    provider: row.provider as EnvironmentDeployComposeCheckout['provider'],
    cloneUrl: row.repositoryUrl,
    ref: composeBase.ref,
    // The commit the compose file was read from, whatever the provider answers.
    commitSha: composeBase.commitSha,
    composePath: composeBase.path,
    credential: resolved.credential,
    credentialKind: resolved.credentialKind,
    credentialUsername: resolved.credentialUsername,
  })
}
