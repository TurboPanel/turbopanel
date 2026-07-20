import type { Context } from 'hono'
import { getPublicUrls, publicUrlEntryToInstallOrigin } from '../admin/public-urls.ts'
import { getDb } from '../db.ts'
import { collectServerAddresses } from '../server-addresses-deno.ts'

function readCaddyPort(): string {
  if (typeof Deno === 'undefined') return '8443'
  return Deno.env.get('CADDY_PORT')?.trim() || '8443'
}

/**
 * Validate an origin/host candidate with the same rules as install-base URL
 * parsing. Returns a trimmed origin, or null when the value is unusable.
 */
function validatedInstallOrigin(
  candidate: string | undefined,
  opts: { allowHttp?: boolean } = {},
): string | null {
  const trimmed = candidate?.trim()
  if (!trimmed) return null
  return publicUrlEntryToInstallOrigin(trimmed, readCaddyPort(), opts)
}

/**
 * Parse a user-supplied public base URL (dev install command override).
 *
 * Production requires HTTPS: plaintext `http:` is rejected unless the caller
 * passes the development-only `{ allowHttp: true }` allowance, so a plaintext
 * control-plane URL cannot leak into a managed install command.
 */
export function parseInstallBaseUrl(
  value: string | undefined,
  opts: { allowHttp?: boolean } = {},
): string | null {
  return validatedInstallOrigin(value, opts)
}

/** First non-empty entry → install origin, or null when missing/unusable. */
function originFromFirstPublicUrlEntry(entries: readonly string[]): string | null {
  const first = entries[0]?.trim()
  if (!first) return null
  return publicUrlEntryToInstallOrigin(first, readCaddyPort())
}

async function resolveStoredPublicUrlOrigin(c: Context): Promise<string | null> {
  const db = getDb(c)
  if (db) {
    const parsed = originFromFirstPublicUrlEntry(await getPublicUrls(db))
    if (parsed) return parsed
  }

  if (typeof Deno === 'undefined') return null

  const publicUrls = Deno.env.get('TURBOPANEL_PUBLIC_URLS')?.trim()
  if (!publicUrls) return null

  return originFromFirstPublicUrlEntry(publicUrls.split(','))
}

/**
 * Public HTTPS base URL for the instance (Caddy entrypoint), used in install commands
 * and verification links. Behind the Unix socket, `new URL(c.req.url).origin` is null —
 * prefer operator-managed public URLs, then TURBOPANEL_BASE_URL, forwarded headers, or
 * a discovered host address.
 *
 * Every untrusted fallback (env, forwarded headers, request origin) is validated with
 * the same origin rules as {@link parseInstallBaseUrl} before it is returned.
 */
export async function resolvePublicBaseUrl(
  c: Context,
  opts?: { baseUrl?: string },
): Promise<string> {
  const fromStored = await resolveStoredPublicUrlOrigin(c)
  if (fromStored) return fromStored

  const fromOpts = validatedInstallOrigin(opts?.baseUrl)
  if (fromOpts) return fromOpts

  const platformEnv = c.get('platformEnv') as Record<string, string | undefined> | undefined
  const fromWorkersEnv = validatedInstallOrigin(platformEnv?.TURBOPANEL_BASE_URL)
  if (fromWorkersEnv) return fromWorkersEnv

  if (typeof Deno !== 'undefined') {
    const fromEnv = validatedInstallOrigin(Deno.env.get('TURBOPANEL_BASE_URL'))
    if (fromEnv) return fromEnv
  }

  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost && forwardedHost !== 'null') {
    // Only accept https origins from forwarded headers — plaintext or malformed
    // hosts (paths, query strings, shell metacharacters) are ignored.
    const proto = forwardedProto === 'http' ? 'http' : 'https'
    const fromForwarded = validatedInstallOrigin(`${proto}://${forwardedHost}`)
    if (fromForwarded) return fromForwarded
  }

  try {
    const fromRequest = validatedInstallOrigin(new URL(c.req.url).origin)
    if (fromRequest) return fromRequest
  } catch {
    // Unix socket or relative request URL — fall through.
  }

  const port = readCaddyPort()
  if (typeof Deno !== 'undefined') {
    const addresses = collectServerAddresses()
    const host =
      addresses.publicIpv4[0] ||
      addresses.privateIpv4[0] ||
      'localhost'
    return `https://${host}:${port}`
  }

  return `https://localhost:${port}`
}
