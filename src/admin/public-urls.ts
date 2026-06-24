import { eq } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { setting } from '../lib/db/schema.ts'

const PUBLIC_URLS_SETTING_KEY = 'TURBOPANEL_PUBLIC_URLS'

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}

function stripIpv6Brackets(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '')
}

function isValidPublicHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname)
  return host.length > 0 && host !== 'null' && host !== 'localhost'
}

function hasNonOriginUrlParts(url: URL): boolean {
  if (url.pathname !== '/' && url.pathname !== '') return true
  if (url.search) return true
  if (url.hash) return true
  return false
}

/** Parse one URL or bare host into a normalized hostname, or null to skip. */
export function hostFromPublicUrlEntry(entry: string): string | null {
  const trimmed = entry.trim()
  if (!trimmed) return null
  let host: string
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return null
  }
  host = stripIpv6Brackets(host)
  if (!isValidPublicHost(host)) return null
  return host
}

/**
 * Normalize a stored or env public URL entry to an HTTPS origin for install commands.
 * Accepts persisted origin strings and bare host / host:port forms.
 */
export function publicUrlEntryToInstallOrigin(
  entry: string,
  defaultHttpsPort = '8443',
): string | null {
  const trimmed = entry.trim()
  if (!trimmed) return null

  try {
    if (trimmed.includes('://')) {
      const url = new URL(trimmed)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (!isValidPublicHost(url.hostname)) return null
      if (url.username || url.password) return null
      if (hasNonOriginUrlParts(url)) return null
      return trimTrailingSlash(url.origin)
    }

    if (/[/?#@]/.test(trimmed)) return null

    const url = new URL(`https://${trimmed}`)
    if (!isValidPublicHost(url.hostname)) return null
    if (url.pathname !== '/' && url.pathname !== '') return null

    const host = url.hostname
    const port = url.port || defaultHttpsPort
    const hostPart = host.includes(':') ? `[${host}]` : host
    return `https://${hostPart}:${port}`
  } catch {
    return null
  }
}

function parseAndNormalizePublicUrlEntry(entry: string): string | null {
  const trimmed = entry.trim()
  if (!trimmed) return null

  if (trimmed.includes('://')) {
    try {
      const url = new URL(trimmed)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (!isValidPublicHost(url.hostname)) return null
      if (url.username || url.password) return null
      if (hasNonOriginUrlParts(url)) return null
      return url.origin
    } catch {
      return null
    }
  }

  if (/[/?#@]/.test(trimmed)) return null

  try {
    const url = new URL(`https://${trimmed}`)
    if (!isValidPublicHost(url.hostname)) return null
    if (url.pathname !== '/' && url.pathname !== '') return null

    const host = stripIpv6Brackets(url.hostname)
    const port = url.port
    if (port) {
      return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
    }
    return host
  } catch {
    return null
  }
}

export type ParsePublicUrlEntriesResult =
  | { ok: true; urls: string[] }
  | { ok: false; error: string; invalid: string[] }

export function parsePublicUrlEntries(raw: string[]): ParsePublicUrlEntriesResult {
  const validated: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  for (const entry of raw) {
    const normalized = parseAndNormalizePublicUrlEntry(entry)
    if (!normalized) {
      invalid.push(entry)
      continue
    }
    const dedupeKey = publicUrlEntryToInstallOrigin(normalized) ?? normalized
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    validated.push(normalized)
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      error: 'One or more public URL entries are invalid',
      invalid,
    }
  }

  return { ok: true, urls: validated }
}

export async function getPublicUrls(db: Db): Promise<string[]> {
  const rows = await db
    .select()
    .from(setting)
    .where(eq(setting.key, PUBLIC_URLS_SETTING_KEY))
    .limit(1)
  const raw = rows[0]?.value
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
}

export async function setPublicUrls(db: Db, urls: string[]): Promise<void> {
  const value = urls.join(',')
  await db
    .insert(setting)
    .values({
      key: PUBLIC_URLS_SETTING_KEY,
      value,
    })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value,
        updatedAt: new Date().toISOString(),
      },
    })
}
