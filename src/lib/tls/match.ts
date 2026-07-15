/**
 * Hostname coverage and org TLS library resolution (pin + auto-match).
 */

import type {
  ResolveTlsResult,
  TlsCandidate,
  TlsMetadata,
  TlsOptions,
} from './types.ts'

/** Normalize hostname for matching (lowercase, strip trailing dot). */
export function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase()
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed
}

/**
 * Exact DNS name or one-label wildcard (`*.example.com` matches `a.example.com`,
 * not apex `example.com` or deeper `a.b.example.com`).
 */
export function coversHostname(dnsNames: string[], hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (host.length === 0) return false
  for (const raw of dnsNames) {
    const name = normalizeHostname(raw)
    if (name === host) return true
    if (name.startsWith('*.')) {
      const suffix = name.slice(1) // ".example.com"
      if (!host.endsWith(suffix)) continue
      const label = host.slice(0, host.length - suffix.length)
      if (label.length > 0 && !label.includes('.')) return true
    }
  }
  return false
}

export function coversAllHostnames(
  dnsNames: string[],
  hostnames: string[],
): boolean {
  if (hostnames.length === 0) return false
  return hostnames.every((h) => coversHostname(dnsNames, h))
}

function isReadyCandidate(
  metadata: TlsMetadata,
  now: Date,
): boolean {
  if (metadata.status !== 'ready') return false
  const notAfter = Date.parse(metadata.notAfter)
  const notBefore = Date.parse(metadata.notBefore)
  if (Number.isNaN(notAfter) || Number.isNaN(notBefore)) return false
  return now.getTime() >= notBefore && now.getTime() <= notAfter
}

type Ranked = {
  id: string
  exactCount: number
  longestWildcard: number
  prefer: number
  notAfterMs: number
}

function rankCandidate(
  candidate: TlsCandidate,
  hostnames: string[],
): Ranked | null {
  const names = candidate.metadata.dnsNames
  if (!coversAllHostnames(names, hostnames)) return null

  let exactCount = 0
  let longestWildcard = 0
  for (const hostname of hostnames) {
    const host = normalizeHostname(hostname)
    for (const raw of names) {
      const name = normalizeHostname(raw)
      if (name === host) {
        exactCount += 1
        break
      }
      if (name.startsWith('*.') && coversHostname([name], host)) {
        longestWildcard = Math.max(longestWildcard, name.length)
      }
    }
  }

  const prefer =
    typeof candidate.options?.prefer === 'number' &&
      Number.isFinite(candidate.options.prefer)
      ? candidate.options.prefer
      : 0
  const notAfterMs = Date.parse(candidate.metadata.notAfter) || 0

  return {
    id: candidate.id,
    exactCount,
    longestWildcard,
    prefer,
    notAfterMs,
  }
}

function compareRanked(a: Ranked, b: Ranked): number {
  if (b.exactCount !== a.exactCount) return b.exactCount - a.exactCount
  if (b.longestWildcard !== a.longestWildcard) {
    return b.longestWildcard - a.longestWildcard
  }
  if (b.prefer !== a.prefer) return b.prefer - a.prefer
  return b.notAfterMs - a.notAfterMs
}

/**
 * Resolve which org TLS cert (if any) should cover a hosting.
 * - pin set → must cover all hostnames and be ready
 * - else best auto match among ready covering candidates
 * - else tls internal (`tlsId: null`)
 */
export function resolveTlsForHosting(params: {
  pinId: string | null | undefined
  hostnames: string[]
  candidates: TlsCandidate[]
  now?: Date
}): ResolveTlsResult {
  const now = params.now ?? new Date()
  const hostnames = params.hostnames
    .map(normalizeHostname)
    .filter((h) => h.length > 0)

  if (hostnames.length === 0) {
    return { ok: true, tlsId: null, reason: 'internal' }
  }

  const byId = new Map(params.candidates.map((c) => [c.id, c]))

  if (params.pinId) {
    const pinned = byId.get(params.pinId)
    if (!pinned) {
      return { ok: false, error: 'pin_not_found' }
    }
    if (!isReadyCandidate(pinned.metadata, now)) {
      return { ok: false, error: 'pin_not_ready' }
    }
    if (!coversAllHostnames(pinned.metadata.dnsNames, hostnames)) {
      return { ok: false, error: 'pin_mismatch' }
    }
    return { ok: true, tlsId: pinned.id, reason: 'pin' }
  }

  const ranked: Ranked[] = []
  for (const candidate of params.candidates) {
    if (!isReadyCandidate(candidate.metadata, now)) continue
    const rank = rankCandidate(candidate, hostnames)
    if (rank) ranked.push(rank)
  }

  if (ranked.length === 0) {
    return { ok: true, tlsId: null, reason: 'internal' }
  }

  ranked.sort(compareRanked)
  return { ok: true, tlsId: ranked[0]!.id, reason: 'auto' }
}

export function parseTlsMetadata(value: unknown): TlsMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.dnsNames) || !record.dnsNames.every((n) => typeof n === 'string')) {
    return null
  }
  if (typeof record.hasWildcard !== 'boolean') return null
  if (typeof record.notBefore !== 'string' || typeof record.notAfter !== 'string') {
    return null
  }
  if (typeof record.fingerprintSha256 !== 'string') return null
  if (typeof record.subject !== 'string' || typeof record.issuer !== 'string') {
    return null
  }
  const status = record.status
  if (
    status !== 'ready' &&
    status !== 'pending' &&
    status !== 'expired' &&
    status !== 'failed' &&
    status !== 'revoked'
  ) {
    return null
  }
  return {
    dnsNames: record.dnsNames as string[],
    hasWildcard: record.hasWildcard,
    notBefore: record.notBefore,
    notAfter: record.notAfter,
    fingerprintSha256: record.fingerprintSha256,
    subject: record.subject,
    issuer: record.issuer,
    status,
  }
}

export function parseTlsOptions(value: unknown): TlsOptions | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const options: TlsOptions = {}
  if (typeof record.prefer === 'number' && Number.isFinite(record.prefer)) {
    options.prefer = record.prefer
  }
  if (typeof record.autoRenew === 'boolean') {
    options.autoRenew = record.autoRenew
  }
  if (
    Array.isArray(record.requestedHostnames) &&
    record.requestedHostnames.every((n) => typeof n === 'string')
  ) {
    options.requestedHostnames = record.requestedHostnames as string[]
  }
  return options
}
