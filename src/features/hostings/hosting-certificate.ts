/**
 * What a hosting (the "domain" row in the panel) shows about its certificate,
 * and the rules for the one-click "Use Let's Encrypt" action.
 *
 * Everything here is pure. The server decides each state and the panel only
 * renders it. The `tls.status` column is deliberately NOT extended: a
 * Let's Encrypt row stays `managed` and `isReadyCandidate` keeps gating deploys
 * on that column alone. "Renewal failed" and "Waiting for DNS" are derived here
 * from the row's issuance details plus the hosting's own pending request.
 */

import { wwwSiblingHostname } from '../../contracts/commands/hostname.ts'
import { isLoopbackOrPrivateHostname } from '../install/install-tls.ts'
import { normalizeIpAddress } from '../../lib/ip-address.ts'
import type { HostingBindScope, HostingProtocol } from './hosting-options.ts'

const MS_PER_DAY = 86_400_000

/** Key on `hosting.metadata` holding a not-yet-satisfiable Let's Encrypt request. */
export const HOSTING_LETS_ENCRYPT_PENDING_KEY = 'letsEncryptPending'

/** A waiting request older than this is dropped by the sweep (the owner can click again). */
export const LETS_ENCRYPT_PENDING_MAX_AGE_DAYS = 7

export type HostingCertificateState =
  'test_certificate' | 'uploaded' | 'secure' | 'waiting_for_dns' | 'issuing' | 'renewal_failed'

export type HostingCertificateSource = 'test' | 'uploaded' | 'lets_encrypt'

export type UploadedExpiryWarning = 'none' | '14d' | '3d' | '1d' | 'expired'

export type HostingDnsHostname = {
  hostname: string
  resolves: boolean
  addresses: string[]
}

export type HostingDnsReport = {
  ready: boolean
  checkedAt: string
  hostnames: HostingDnsHostname[]
  expectedAddresses: string[]
}

export type HostingCertificate = {
  state: HostingCertificateState
  source: HostingCertificateSource
  expiresAt: string | null
  expiresInDays: number | null
  renewsAutomatically: boolean
  lastError: string | null
  lastIssuedAt: string | null
  uploadedExpiryWarning: UploadedExpiryWarning
  dns: HostingDnsReport | null
  letsEncryptAvailable: boolean
  wwwRedirect: boolean
  /** True when the pin is saved but the environment has not been deployed since. */
  needsDeploy: boolean
}

/** The pinned certificate row, as far as the status needs it. */
export type PinnedCertificateRow = {
  source: string
  status: string
  /** `tls.not_after` column (real for uploads; epoch placeholder for managed rows). */
  notAfter: string | null
  /** The residual jsonb (`dnsNames`, `acme`, ...). */
  metadata: unknown
}

export type PendingLetsEncrypt = {
  requestedAt: string
  wwwRedirect: boolean
  dns: HostingDnsReport | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readIso(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) || ms <= 0 ? null : new Date(ms).toISOString()
}

/** The ACME block of a managed row; every field is read defensively. */
function readAcme(metadata: unknown): {
  lastError: string | null
  lastIssuedAt: string | null
  notAfter: string | null
} {
  const acme = isRecord(metadata) && isRecord(metadata.acme) ? metadata.acme : {}
  const lastError =
    typeof acme.lastError === 'string' && acme.lastError.length > 0 ? acme.lastError : null
  return {
    lastError,
    lastIssuedAt: readIso(acme.lastIssuedAt),
    notAfter: readIso(acme.notAfter),
  }
}

export function daysUntil(iso: string, now: Date): number {
  return Math.floor((Date.parse(iso) - now.getTime()) / MS_PER_DAY)
}

export function uploadedExpiryWarning(notAfter: string | null, now: Date): UploadedExpiryWarning {
  const ms = notAfter === null ? Number.NaN : Date.parse(notAfter)
  if (Number.isNaN(ms)) return 'none'
  const left = ms - now.getTime()
  if (left <= 0) return 'expired'
  if (left <= MS_PER_DAY) return '1d'
  if (left <= 3 * MS_PER_DAY) return '3d'
  if (left <= 14 * MS_PER_DAY) return '14d'
  return 'none'
}

export function readPendingLetsEncrypt(metadata: unknown): PendingLetsEncrypt | null {
  if (!isRecord(metadata)) return null
  const raw = metadata[HOSTING_LETS_ENCRYPT_PENDING_KEY]
  if (!isRecord(raw)) return null
  const requestedAt = readIso(raw.requestedAt)
  if (requestedAt === null) return null
  return {
    requestedAt,
    wwwRedirect: raw.wwwRedirect === true,
    dns: isRecord(raw.dns) ? (raw.dns as HostingDnsReport) : null,
  }
}

export function withPendingLetsEncrypt(
  metadata: unknown,
  pending: PendingLetsEncrypt | null
): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(metadata) ? { ...metadata } : {}
  if (pending === null) delete next[HOSTING_LETS_ENCRYPT_PENDING_KEY]
  else next[HOSTING_LETS_ENCRYPT_PENDING_KEY] = pending
  return next
}

export function isPendingExpired(pending: PendingLetsEncrypt, now: Date): boolean {
  return (
    now.getTime() - Date.parse(pending.requestedAt) > LETS_ENCRYPT_PENDING_MAX_AGE_DAYS * MS_PER_DAY
  )
}

/** The names the certificate must cover: the hostnames, plus their siblings when redirecting. */
export function letsEncryptNames(hostnames: readonly string[], wwwRedirect: boolean): string[] {
  const names = new Set<string>()
  for (const raw of hostnames) {
    const name = raw.trim().toLowerCase()
    names.add(name)
    const sibling = wwwRedirect ? wwwSiblingHostname(name) : null
    if (sibling !== null) names.add(sibling)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

export type WwwRedirectConflict = { hostname: string; sibling: string | null }

/**
 * The first hostname the deploy would refuse "also send www to the main name"
 * for, or null. Mirrors `validateDeployWwwRedirects`: the other spelling must
 * be a valid name and must not already be served by this hosting or by another
 * web hosting in the same environment (`others`).
 */
export function wwwRedirectConflict(
  hostnames: readonly string[],
  others: readonly string[]
): WwwRedirectConflict | null {
  const served = new Set([...hostnames, ...others])
  for (const hostname of hostnames) {
    const sibling = wwwSiblingHostname(hostname)
    if (sibling === null || served.has(sibling)) return { hostname, sibling }
  }
  return null
}

/** The sentence for a conflict, naming the two names. */
export function wwwRedirectConflictMessage(conflict: WwwRedirectConflict): string {
  if (conflict.sibling === null) {
    return `"Also send www to the main name" cannot work for ${conflict.hostname}: it has no valid www or non-www twin name.`
  }
  return `"Also send www to the main name" cannot be turned on: both ${conflict.hostname} and ${conflict.sibling} are already listed as domains in this environment. Remove one of them, or leave the option off.`
}

export type LetsEncryptRefusal =
  | 'lets_encrypt_not_enabled'
  | 'hosting_not_http'
  | 'hosting_has_no_hostnames'
  | 'acme_requires_public_bind'
  | 'letsencrypt_hostname_unsupported'
  | 'www_redirect_conflict'

/** Why a name can never get a public certificate over the HTTP check, or null. */
export function hostnameUnsupportedReason(hostname: string): string | null {
  if (hostname.includes('*')) return 'wildcard names need the DNS check, which is not available'
  if (normalizeIpAddress(hostname) !== null) return "Let's Encrypt does not issue for IP addresses"
  if (!hostname.includes('.') || isLoopbackOrPrivateHostname(hostname)) {
    return 'private names cannot get a public certificate'
  }
  return null
}

/**
 * The first reason the one-click action cannot run, or null. Ordered so the
 * most actionable answer wins; shared by the endpoint and by `letsEncryptAvailable`.
 */
export function letsEncryptRefusal(params: {
  acmeEnabled: boolean
  protocol: HostingProtocol
  bind: HostingBindScope
  hostnames: readonly string[]
}): LetsEncryptRefusal | null {
  if (!params.acmeEnabled) return 'lets_encrypt_not_enabled'
  if (params.protocol !== 'http') return 'hosting_not_http'
  if (params.hostnames.length === 0) return 'hosting_has_no_hostnames'
  if (params.bind !== 'public') return 'acme_requires_public_bind'
  if (params.hostnames.some((h) => hostnameUnsupportedReason(h) !== null)) {
    return 'letsencrypt_hostname_unsupported'
  }
  return null
}

export type DeriveHostingCertificateInput = {
  /** The pinned row; null when the hosting has no pin or the pin is revoked/missing. */
  pinned: PinnedCertificateRow | null
  pending: PendingLetsEncrypt | null
  wwwRedirect: boolean
  letsEncryptAvailable: boolean
  /** Pinned, but no deployment has finished since the pin was saved. */
  needsDeploy: boolean
  now: Date
}

function baseCertificate(
  input: DeriveHostingCertificateInput
): Omit<HostingCertificate, 'state' | 'source'> {
  return {
    expiresAt: null,
    expiresInDays: null,
    renewsAutomatically: false,
    lastError: null,
    lastIssuedAt: null,
    uploadedExpiryWarning: 'none',
    dns: null,
    letsEncryptAvailable: input.letsEncryptAvailable,
    wwwRedirect: input.wwwRedirect,
    needsDeploy: false,
  }
}

function deriveUploaded(
  input: DeriveHostingCertificateInput,
  row: PinnedCertificateRow
): HostingCertificate {
  const expiresAt = readIso(row.notAfter)
  return {
    ...baseCertificate(input),
    state: 'uploaded',
    source: 'uploaded',
    expiresAt,
    expiresInDays: expiresAt === null ? null : daysUntil(expiresAt, input.now),
    uploadedExpiryWarning: uploadedExpiryWarning(expiresAt, input.now),
  }
}

function deriveLetsEncrypt(
  input: DeriveHostingCertificateInput,
  row: PinnedCertificateRow
): HostingCertificate {
  const acme = readAcme(row.metadata)
  const base = {
    ...baseCertificate(input),
    source: 'lets_encrypt' as const,
    renewsAutomatically: true,
    lastIssuedAt: acme.lastIssuedAt,
    expiresAt: acme.notAfter,
    expiresInDays: acme.notAfter === null ? null : daysUntil(acme.notAfter, input.now),
  }
  if (acme.lastError !== null) {
    return { ...base, state: 'renewal_failed', lastError: acme.lastError }
  }
  if (acme.notAfter === null) {
    return { ...base, state: 'issuing', needsDeploy: input.needsDeploy }
  }
  if (Date.parse(acme.notAfter) <= input.now.getTime()) {
    return { ...base, state: 'renewal_failed', lastError: 'The certificate has expired.' }
  }
  return { ...base, state: 'secure' }
}

/** Test certificates: no pin, a revoked pin, a self-signed pin, or the organization CA. */
function deriveTest(input: DeriveHostingCertificateInput): HostingCertificate {
  if (input.pending !== null) {
    return {
      ...baseCertificate(input),
      state: 'waiting_for_dns',
      source: 'test',
      dns: input.pending.dns,
      wwwRedirect: input.pending.wwwRedirect,
    }
  }
  return { ...baseCertificate(input), state: 'test_certificate', source: 'test' }
}

/** Flat on purpose: one branch per certificate source. */
export function deriveHostingCertificate(input: DeriveHostingCertificateInput): HostingCertificate {
  const row = input.pinned
  if (row === null || row.status === 'revoked') return deriveTest(input)
  if (row.source === 'lets_encrypt') return deriveLetsEncrypt(input, row)
  if (row.source === 'upload') return deriveUploaded(input, row)
  return deriveTest(input)
}
