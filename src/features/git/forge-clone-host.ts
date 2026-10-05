/**
 * A connection-bound repository may only be cloned from its forge's own host.
 *
 * A source that clones through a forge connection gets a credential minted for
 * that forge (a GitHub installation token or a GitLab OAuth token) and sealed
 * for the daemon, which hands it to git for whatever host `repositoryUrl`
 * names. Nothing tied the two together, so an organization member could name
 * their own server in the URL and receive the credential. This module is the
 * one rule both layers share: the write routes refuse the URL, and the deploy
 * path refuses it again before anything is minted (a row written by anything
 * other than the routes, or a forge whose host changed since).
 *
 * Web APIs only, so it stays reachable from `src/workers.ts`.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { forge, gitConnection } from '../../db/schema.ts'

/** `host[:port]` of an https URL; `null` for anything else (or userinfo). */
function httpsAuthority(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null
  if (parsed.username || parsed.password) return null
  // WHATWG normalizes case, default ports and trailing-dot-free IP spellings.
  return parsed.host.toLowerCase()
}

/**
 * Does `repositoryUrl` live on the forge `forgeBaseUrl` names?
 *
 * Host and port must be equal; the path is the forge's own business (a GitLab
 * behind a sub-path keeps its sub-path). Anything that is not a plain https
 * URL, or carries userinfo, is a mismatch.
 */
export function repositoryUrlMatchesForgeHost(
  repositoryUrl: string,
  forgeBaseUrl: string
): boolean {
  const repositoryHost = httpsAuthority(repositoryUrl)
  const forgeHost = httpsAuthority(forgeBaseUrl)
  return repositoryHost !== null && forgeHost !== null && repositoryHost === forgeHost
}

/** The forge base URL a connection was granted through; `null` when unknown. */
export async function forgeBaseUrlForConnection(
  db: Db,
  connectionId: string
): Promise<string | null> {
  const rows = await db
    .select({ baseUrl: forge.baseUrl })
    .from(gitConnection)
    .innerJoin(forge, eq(gitConnection.forgeId, forge.id))
    .where(eq(gitConnection.id, connectionId))
    .limit(1)
  return rows[0]?.baseUrl ?? null
}

/**
 * `true` when the connection's forge hosts `repositoryUrl`. An unknown
 * connection or forge is a mismatch: nothing may be minted for it.
 */
export async function connectionHostsRepositoryUrl(
  db: Db,
  connectionId: string,
  repositoryUrl: string
): Promise<boolean> {
  const baseUrl = await forgeBaseUrlForConnection(db, connectionId)
  return baseUrl !== null && repositoryUrlMatchesForgeHost(repositoryUrl, baseUrl)
}

/** Failure text shared by both providers' `prepareClone`. */
export const REPOSITORY_HOST_MISMATCH_FAILURE =
  'repository url is not hosted by the connected forge'
