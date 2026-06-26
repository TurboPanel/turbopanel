import type { Context } from 'hono'
import { getPublicUrls, publicUrlEntryToInstallOrigin } from '../admin/public-urls.ts'
import { getDb } from '../db.ts'
import { collectServerAddresses } from '../server-addresses-deno.ts'

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
  return publicUrlEntryToInstallOrigin(trimmed, readCaddyPort())
}

async function resolveStoredPublicUrlOrigin(c: Context): Promise<string | null> {
  const db = getDb(c)
  if (db) {
    const urls = await getPublicUrls(db)
    const first = urls[0]?.trim()
    if (first) {
      const parsed = publicUrlEntryToInstallOrigin(first, readCaddyPort())
      if (parsed) return parsed
    }
  }

  if (typeof Deno !== 'undefined') {
    const publicUrls = Deno.env.get('TURBOPANEL_PUBLIC_URLS')?.trim()
    if (publicUrls) {
      const first = publicUrls.split(',')[0]?.trim()
      if (first) {
        const parsed = publicUrlEntryToInstallOrigin(first, readCaddyPort())
        if (parsed) return parsed
      }
    }
  }

  return null
}

/**
 * Public HTTPS base URL for the instance (Caddy entrypoint), used in install commands
 * and verification links. Behind the Unix socket, `new URL(c.req.url).origin` is null —
 * prefer operator-managed public URLs, then TURBOPANEL_BASE_URL, forwarded headers, or
 * a discovered host address.
 */
export async function resolvePublicBaseUrl(
  c: Context,
  opts?: { baseUrl?: string },
): Promise<string> {
  const fromStored = await resolveStoredPublicUrlOrigin(c)
  if (fromStored) return fromStored

  const fromOpts = opts?.baseUrl?.trim()
  if (fromOpts) return trimTrailingSlash(fromOpts)

  const platformEnv = c.get('platformEnv') as Record<string, string | undefined> | undefined
  const fromWorkersEnv = platformEnv?.TURBOPANEL_BASE_URL?.trim()
  if (fromWorkersEnv) return trimTrailingSlash(fromWorkersEnv)

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
