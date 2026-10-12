/**
 * The origins this control plane publishes for inbound Git traffic: webhook
 * deliveries, the GitHub App manifest's callback and setup URLs, and the
 * GitLab OAuth redirect.
 *
 * Two sources, chosen by runtime:
 *
 * - **Self-hosted (Deno):** the operator-managed public URL list only. Never
 *   the request origin: behind the local Caddy → Unix socket the request
 *   origin is not an address any provider can dial, so echoing it back would
 *   produce a URL that looks right and never receives anything. A
 *   `TURBOPANEL_BASE_URL` in the process env is not consulted either — the
 *   operator list is the one place a self-hosted address is published.
 * - **Hosted (Workers):** the platform's own address, `TURBOPANEL_BASE_URL`,
 *   first, then anything in the stored list. Nothing fills that list on the
 *   hosted runtime (its hostnames are platform-managed, see
 *   `admin/instance-hostname-routes.ts`), so without the base URL the hosted
 *   control plane would publish nothing and every GitHub App wizard would be
 *   refused with `public_url_not_configured`.
 *
 * The base URL goes through {@link publicHttpsOrigin}, not the self-hosted
 * {@link publicUrlEntryToInstallOrigin}: the hosted origin keeps its own port
 * (usually the implicit 443), where the self-hosted one always dials `:8443`.
 * A blank, `http:` or otherwise unusable value publishes nothing.
 */

import type { Db } from '../../db/connection.ts'
import {
  getPublicUrls,
  publicHttpsOrigin,
  publicUrlEntryToInstallOrigin,
} from '../install/public-urls.ts'

export type PublishedOrigins = {
  /** Normalized origins, no trailing slash, the preferred one first. */
  origins: string[]
  /**
   * True on the hosted runtime, where the address is set by the platform
   * rather than by an operator under Networking.
   */
  platformManaged: boolean
}

export type PublishedOriginsRuntime = {
  runtime?: 'deno' | 'workers'
  platformEnv?: Record<string, string | undefined>
}

/** The hosted runtime's own address, or `null` off Workers or when unusable. */
export function platformManagedOrigin(input: PublishedOriginsRuntime): string | null {
  if (input.runtime !== 'workers') return null
  const baseUrl = input.platformEnv?.TURBOPANEL_BASE_URL?.trim()
  if (!baseUrl) return null
  return publicHttpsOrigin(baseUrl)
}

function stripTrailingSlash(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

/**
 * Every published origin: the platform address (when given) ahead of the
 * stored operator list, normalized and de-duplicated.
 */
export async function listPublishedOrigins(
  db: Db,
  platformOrigin: string | null = null
): Promise<string[]> {
  const stored = (await getPublicUrls(db))
    .map((entry) => publicUrlEntryToInstallOrigin(entry))
    .filter((origin): origin is string => origin !== null)
  const all = platformOrigin ? [platformOrigin, ...stored] : stored
  return [...new Set(all.map(stripTrailingSlash))]
}

export async function resolvePublishedOrigins(
  db: Db,
  input: PublishedOriginsRuntime
): Promise<PublishedOrigins> {
  return {
    origins: await listPublishedOrigins(db, platformManagedOrigin(input)),
    platformManaged: input.runtime === 'workers',
  }
}

/** The origin to build URLs from: the first https one, else the first, else `null`. */
export function preferredPublishedOrigin(origins: readonly string[]): string | null {
  return origins.find((origin) => origin.startsWith('https://')) ?? origins[0] ?? null
}

/**
 * The published origin a caller-chosen value names, or `null` when it names
 * none.
 *
 * Both normalizations are tried because the two sources normalize
 * differently: a stored self-hosted entry is known by its `:8443` dial, the
 * hosted address by its own port. Only origins already in `origins` can
 * match, so trying both never admits an address this instance does not
 * publish.
 */
export function matchPublishedOrigin(origins: readonly string[], chosen: string): string | null {
  const candidates = [publicUrlEntryToInstallOrigin(chosen), publicHttpsOrigin(chosen)]
  for (const candidate of candidates) {
    if (candidate && origins.includes(stripTrailingSlash(candidate))) {
      return stripTrailingSlash(candidate)
    }
  }
  return null
}
