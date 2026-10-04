/**
 * A provider repository id is only bound to a source when the connection the
 * source is bound through can see that repository.
 *
 * Push deliveries are matched to sources by `repositoryExternalId`. GitLab names
 * only the project on a delivery, never the connection, so on an instance-wide
 * GitLab app every organization's connections are candidates and the project id
 * alone picks the sources (see `loadInstallations` in `webhook-trigger.ts`).
 * That is only sound if an organization cannot record a project id it has no
 * access to: otherwise another tenant's pushes would trigger its deploys and
 * write that tenant's branch names and commits into its history. The proof is
 * the same listing `/repositories/:id/refresh` and the picker already use: the
 * organization's own connection, with its own token, must list the id.
 */
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { type GitProvider, resolveGitProvider } from '../../features/git/git-provider.ts'

/**
 * Providers whose push deliveries are matched by repository id alone. GitHub
 * names the installation on every delivery and an installation is claimed by
 * one organization (`assertConnectionUnclaimed`), so a foreign GitHub id can
 * never match another tenant's pushes and needs no provider round trip.
 */
const MATCHED_BY_REPOSITORY_ID: ReadonlySet<string> = new Set(['gitlab'])

export type SourceBinding = {
  provider: string
  connectionId: string | null
  repositoryExternalId: string | null
}

/** The binding a PATCH leaves behind: patched fields over the stored row. */
export function sourceBindingAfterPatch(
  stored: SourceBinding,
  patch: { connectionId?: string | null; repositoryExternalId?: string | null }
): SourceBinding | null {
  if (patch.connectionId === undefined && patch.repositoryExternalId === undefined) return null
  return {
    provider: stored.provider,
    connectionId: patch.connectionId === undefined ? stored.connectionId : patch.connectionId,
    repositoryExternalId:
      patch.repositoryExternalId === undefined
        ? stored.repositoryExternalId
        : patch.repositoryExternalId,
  }
}

/**
 * `undefined` when the binding is fine (or names no provider repository);
 * otherwise the response to send. `onProviderError` maps a provider failure
 * the same way the other repository routes do. `resolveProvider` is a test seam.
 */
export async function assertSourceVisibleToConnection(
  c: Context<AppEnv>,
  db: Db,
  binding: SourceBinding | null,
  onProviderError: (error: unknown) => Response,
  resolveProvider: (provider: string) => Pick<GitProvider, 'listRepositories'> = resolveGitProvider
): Promise<Response | undefined> {
  if (!binding?.connectionId || !binding.repositoryExternalId) return undefined
  if (!MATCHED_BY_REPOSITORY_ID.has(binding.provider)) return undefined
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Data encryption unavailable' }, 503)
  }
  let listing
  try {
    listing = await resolveProvider(binding.provider).listRepositories(
      { db, dataEncryptionSecrets },
      binding.connectionId
    )
  } catch (error) {
    return onProviderError(error)
  }
  if (listing.some((entry) => entry.id === binding.repositoryExternalId)) return undefined
  return c.json(
    {
      error: 'source_not_visible_to_connection',
      message: 'The connection cannot see this repository.',
    },
    404
  )
}
