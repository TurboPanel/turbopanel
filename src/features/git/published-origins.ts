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
 * - **Hosted (Workers):** the platform's own addresses only,
 *   `TURBOPANEL_BASE_URL` then `TURBOPANEL_PUBLIC_URLS`. Stored hostname rows
 *   are ignored on this runtime (its hostnames are platform-managed, see
 *   `features/install/control-plane-origins.ts`), so without the base URL the
 *   hosted control plane publishes nothing and every GitHub App wizard is
 *   refused with `public_url_not_configured`.
 *
 * The hosted origin is always port-free (the control plane answers on 443
 * there), where the self-hosted one dials `:8443`. A blank, `http:` or
 * otherwise unusable value publishes nothing.
 */

import type { Db } from '../../db/connection.ts'
import {
  controlPlaneOrigins,
  platformControlPlaneOrigin,
} from '../install/control-plane-origins.ts'
import { publicHttpsOrigin, publicUrlEntryToInstallOrigin } from '../install/public-urls.ts'

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
  return platformControlPlaneOrigin(input.platformEnv)
}

function stripTrailingSlash(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

/**
 * Every published origin for this runtime, normalized and de-duplicated: the
 * platform addresses on Workers, the stored list on Deno.
 */
export async function listPublishedOrigins(
  db: Db,
  input: PublishedOriginsRuntime = {}
): Promise<string[]> {
  const origins = await controlPlaneOrigins(db, input)
  return [...new Set(origins.map(stripTrailingSlash))]
}

export async function resolvePublishedOrigins(
  db: Db,
  input: PublishedOriginsRuntime
): Promise<PublishedOrigins> {
  return {
    origins: await listPublishedOrigins(db, input),
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
 * hosted address by its own port. An old `:8443` spelling also matches the
 * same host published without a port. Only origins already in `origins` can
 * match, so trying both never admits an address this instance does not
 * publish.
 */
export function matchPublishedOrigin(origins: readonly string[], chosen: string): string | null {
  const dialed = publicUrlEntryToInstallOrigin(chosen)
  // A webhook registered while the name was published on :8443 still names the
  // same host once its public port moves to 443.
  const portless = dialed?.endsWith(':8443') ? dialed.slice(0, -':8443'.length) : null
  const candidates = [dialed, publicHttpsOrigin(chosen), portless]
  for (const candidate of candidates) {
    if (candidate && origins.includes(stripTrailingSlash(candidate))) {
      return stripTrailingSlash(candidate)
    }
  }
  return null
}
