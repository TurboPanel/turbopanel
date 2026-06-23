import type { Context } from 'hono'
import { collectServerAddresses } from '../server-addresses.ts'

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}

function isUsableOrigin(origin: string): boolean {
  return origin.length > 0 && origin !== 'null' && !origin.includes('://null')
}

function readCaddyPort(): string {
  if (typeof Deno === 'undefined') return '8443'
  return Deno.env.get('CADDY_PORT')?.trim() || '8443'
}

/** Parse a user-supplied public HTTPS base URL (dev install command override). */
export function parseInstallBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname || url.hostname === 'null') return null
    return trimTrailingSlash(url.origin)
  } catch {
    return null
  }
}

/**
 * Public HTTPS base URL for the instance (Caddy entrypoint), used in install commands
 * and verification links. Behind the Unix socket, `new URL(c.req.url).origin` is null —
 * prefer TURBOPANEL_BASE_URL, forwarded headers, or a discovered host address.
 */
export function resolvePublicBaseUrl(
  c: Context,
  opts?: { baseUrl?: string },
): string {
  const fromOpts = opts?.baseUrl?.trim()
  if (fromOpts) return trimTrailingSlash(fromOpts)

  if (typeof Deno !== 'undefined') {
    const fromEnv = Deno.env.get('TURBOPANEL_BASE_URL')?.trim()
    if (fromEnv) return trimTrailingSlash(fromEnv)
  }

  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost && forwardedHost !== 'null') {
    const proto =
      forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : 'https'
    const origin = trimTrailingSlash(`${proto}://${forwardedHost}`)
    if (isUsableOrigin(origin)) return origin
  }

  try {
    const origin = new URL(c.req.url).origin
    if (isUsableOrigin(origin)) return trimTrailingSlash(origin)
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
