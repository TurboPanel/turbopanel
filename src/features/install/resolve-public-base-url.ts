import type { Context } from 'hono'
import { fixedPublicPort } from './ingress-modes.ts'
import { controlPlaneHostnameRows, platformControlPlaneOrigin } from './control-plane-origins.ts'
import { installUrlsFor, primaryHostname, publicOriginForHostname } from './public-origins.ts'
import {
  PANEL_HTTPS_PORT,
  publicHttpsOrigin,
  publicUrlEntryToInstallOrigin,
} from './public-urls.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { discoverHostIpv4 } from '../../platform/ports/host-ipv4-discovery.ts'

/**
 * Scheme-bearing HTTPS keeps its port (443 stays the standard origin).
 * A bare host is the self-hosted Caddy dial and becomes `:8443`.
 * Plaintext `http:` is rejected. `CADDY_PORT` is not consulted.
 */
function validatedPublicHttpsOrigin(candidate: string | undefined): string | null {
  const trimmed = candidate?.trim()
  if (!trimmed) return null
  // Self-hosted: the address is always the 8443 listener, even for a forwarded
  // host or base URL that a tunnel answers on 443.
  if (trimmed.includes('://') && fixedPublicPort() === null) return publicHttpsOrigin(trimmed)
  return publicUrlEntryToInstallOrigin(trimmed)
}

/**
 * Parse a user-supplied public base URL (install command override).
 * Plaintext `http:` is rejected. An already valid HTTPS origin keeps its
 * port. A bare host dials the self-hosted listener on {@link PANEL_HTTPS_PORT}.
 */
export function parseInstallBaseUrl(value: string | undefined): string | null {
  return validatedPublicHttpsOrigin(value)
}

/** True when the request is served by the hosted (Workers) runtime. */
function isHostedRuntime(c: Context): boolean {
  return c.get('runtime') === 'workers'
}

function platformEnvOf(c: Context): Record<string, string | undefined> | undefined {
  return c.get('platformEnv') as Record<string, string | undefined> | undefined
}

/**
 * The control plane's own configured origin: the platform environment on
 * Workers (stored rows ignored), the primary stored hostname on Deno (the
 * process environment ignored). `null` when the runtime's one source is empty.
 */
async function resolveConfiguredOrigin(c: Context): Promise<string | null> {
  if (isHostedRuntime(c)) return platformControlPlaneOrigin(platformEnvOf(c))
  const db = getDb(c)
  return db ? await primaryStoredOrigin(db) : null
}

/** Public origin of the primary stored hostname (else the oldest), or `null` with none. */
async function primaryStoredOrigin(db: Db): Promise<string | null> {
  const primary = primaryHostname(await controlPlaneHostnameRows(db, 'deno'))
  return primary ? publicOriginForHostname(primary) : null
}

/** The discovered host address on the self-hosted listener: the last fallback. */
function discoveredHostOrigin(): string {
  const host = discoverHostIpv4() || 'localhost'
  return `https://${host}:${PANEL_HTTPS_PORT}`
}

/**
 * The self-hosted console address for mail sent outside a request (alerts,
 * digests, retries, certificate notices): the primary hostname saved under
 * Admin › Access › Hostnames, else the discovered host address. Never the
 * process environment. Callers resolve it at send time (or per tick), so a
 * hostname change shows up in the next mail without a restart.
 */
export async function resolveSelfHostedConsoleBaseUrl(db: Db): Promise<string> {
  return (await primaryStoredOrigin(db)) ?? discoveredHostOrigin()
}

/**
 * Public HTTPS base URL for the instance (Caddy entrypoint), used in install commands
 * and verification links. Behind the Unix socket, `new URL(c.req.url).origin` is null.
 * Order: the runtime's configured origin (the platform `TURBOPANEL_BASE_URL` /
 * `TURBOPANEL_PUBLIC_URLS` on Workers, the primary stored hostname on Deno; see
 * `control-plane-origins.ts`), then an explicit `baseUrl`, the forwarded
 * headers, and last the discovered host address. A self-hosted control plane
 * never reads the process environment for its address.
 *
 * Hosted and externally forwarded origins keep their HTTPS port. A bare
 * stored hostname, and the discovered-address fallback, dial the self-hosted
 * listener. Plaintext `http:` is rejected.
 *
 * `allowRequestHost: false` is for links that are *mailed to someone else*
 * (verification, password reset, invitations, notification mail): the
 * forwarded host and the request URL are caller-supplied text, so with no base
 * URL configured a spoofed `X-Forwarded-Host` would put the attacker's host in
 * a mail to the victim. Those links fall back to the discovered host address.
 */
export async function resolvePublicBaseUrl(
  c: Context,
  opts?: { baseUrl?: string; allowRequestHost?: boolean }
): Promise<string> {
  const fromConfigured = await resolveConfiguredOrigin(c)
  if (fromConfigured) return fromConfigured

  const fromOpts = validatedPublicHttpsOrigin(opts?.baseUrl)
  if (fromOpts) return fromOpts

  const fromRequestHost = opts?.allowRequestHost !== false ? originFromRequestHost(c) : null
  if (fromRequestHost) return fromRequestHost

  return discoveredHostOrigin()
}

/**
 * Base URL for a new server's install command: the primary hostname when
 * servers dial it, else the first other dialable hostname, else the usual
 * public base URL.
 */
export async function resolveInstallBaseUrl(
  c: Context,
  opts?: { baseUrl?: string; allowRequestHost?: boolean }
): Promise<string> {
  const db = getDb(c)
  const dialable =
    db && !isHostedRuntime(c)
      ? installUrlsFor(await controlPlaneHostnameRows(db, 'deno'))[0]
      : undefined
  return dialable ?? (await resolvePublicBaseUrl(c, opts))
}

/** The origin the request itself names: forwarded host first, then the request URL. */
function originFromRequestHost(c: Context): string | null {
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim()
  if (forwardedHost && forwardedHost !== 'null') {
    // Only accept https origins from forwarded headers — malformed hosts
    // (paths, query strings, shell metacharacters) are ignored.
    const fromForwarded = validatedPublicHttpsOrigin(`https://${forwardedHost}`)
    if (fromForwarded) return fromForwarded
  }

  try {
    return validatedPublicHttpsOrigin(new URL(c.req.url).origin)
  } catch {
    // Unix socket or relative request URL — no origin to offer.
    return null
  }
}
