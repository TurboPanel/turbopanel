import type { Context } from 'hono'
import { listInstanceHostnames } from './instance-hostnames.ts'
import { installUrlsFor, primaryHostname, publicOriginForHostname } from './public-origins.ts'
import {
  PANEL_HTTPS_PORT,
  publicHttpsOrigin,
  publicUrlEntryToInstallOrigin,
} from './public-urls.ts'
import { getDb } from '../../db/connection.ts'
import { discoverHostIpv4 } from '../../platform/ports/host-ipv4-discovery.ts'

/**
 * Scheme-bearing HTTPS keeps its port (443 stays the standard origin).
 * A bare host is the self-hosted Caddy dial and becomes `:8443`.
 * Plaintext `http:` is rejected. `CADDY_PORT` is not consulted.
 */
function validatedPublicHttpsOrigin(candidate: string | undefined): string | null {
  const trimmed = candidate?.trim()
  if (!trimmed) return null
  if (trimmed.includes('://')) return publicHttpsOrigin(trimmed)
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

async function resolveStoredPublicUrlOrigin(c: Context): Promise<string | null> {
  const db = getDb(c)
  if (db) {
    const primary = primaryHostname(await listInstanceHostnames(db))
    const stored = primary ? publicOriginForHostname(primary) : null
    if (stored) return stored
  }

  if (typeof Deno === 'undefined') return null

  const publicUrls = Deno.env.get('TURBOPANEL_PUBLIC_URLS')?.trim()
  if (!publicUrls) return null

  // The installer writes the self-hosted panel's own names here, so each one
  // dials the panel's listener on 8443 even when written as `https://host`.
  const first = publicUrls.split(',')[0]?.trim()
  return first ? publicUrlEntryToInstallOrigin(first) : null
}

/**
 * Public HTTPS base URL for the instance (Caddy entrypoint), used in install commands
 * and verification links. Behind the Unix socket, `new URL(c.req.url).origin` is null —
 * prefer operator-managed public URLs, then TURBOPANEL_BASE_URL, forwarded headers, or
 * a discovered host address.
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
  const fromStored = await resolveStoredPublicUrlOrigin(c)
  if (fromStored) return fromStored

  const fromOpts = validatedPublicHttpsOrigin(opts?.baseUrl)
  if (fromOpts) return fromOpts

  const platformEnv = c.get('platformEnv') as Record<string, string | undefined> | undefined
  const fromWorkersEnv = validatedPublicHttpsOrigin(platformEnv?.TURBOPANEL_BASE_URL)
  if (fromWorkersEnv) return fromWorkersEnv

  if (typeof Deno !== 'undefined') {
    const fromEnv = validatedPublicHttpsOrigin(Deno.env.get('TURBOPANEL_BASE_URL'))
    if (fromEnv) return fromEnv
  }

  const fromRequestHost = opts?.allowRequestHost !== false ? originFromRequestHost(c) : null
  if (fromRequestHost) return fromRequestHost

  const host = discoverHostIpv4() || 'localhost'
  return `https://${host}:${PANEL_HTTPS_PORT}`
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
  const dialable = db ? installUrlsFor(await listInstanceHostnames(db))[0] : undefined
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
