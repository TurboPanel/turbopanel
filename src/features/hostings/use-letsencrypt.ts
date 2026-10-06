/**
 * The one-click "Use Let's Encrypt" decision for one hosting, and the retry the
 * periodic sweep runs for requests that were waiting on DNS.
 *
 * All storage goes through {@link LetsEncryptStore}, so the rules here (gate on
 * DNS, reuse a matching certificate row, remember a waiting request) are tested
 * without a database and without touching the network.
 */

import {
  type HostingDnsReport,
  type LetsEncryptRefusal,
  type PendingLetsEncrypt,
  isPendingExpired,
  letsEncryptNames,
  letsEncryptRefusal,
  readPendingLetsEncrypt,
  withPendingLetsEncrypt,
  wwwRedirectConflict,
  wwwRedirectConflictMessage,
} from './hosting-certificate.ts'
import { type DnsLookup, checkHostingDns } from './hosting-dns-check.ts'
import {
  parseHostingOptions,
  readHostingWwwMode,
  resolveHostingBind,
  resolveHostingProtocol,
} from './hosting-options.ts'

export type LetsEncryptHostingRecord = {
  id: string
  organizationId: string
  tlsId: string | null
  options: unknown
  metadata: unknown
}

export type LetsEncryptStore = {
  /** The public addresses of the server this hosting is deployed to (the pinned IP wins). */
  expectedAddresses(hosting: LetsEncryptHostingRecord): Promise<string[]>
  /** Hostnames of the other web hostings in this hosting's environment (what a www twin must not collide with). */
  otherWebHostnames(hosting: LetsEncryptHostingRecord): Promise<string[]>
  /** A live managed Let's Encrypt row of the organization whose names equal `names`, if any. */
  findManagedCertificate(organizationId: string, names: readonly string[]): Promise<string | null>
  createManagedCertificate(organizationId: string, names: readonly string[]): Promise<string>
  saveHosting(
    hostingId: string,
    patch: { tlsId?: string; options?: Record<string, unknown>; metadata?: Record<string, unknown> }
  ): Promise<void>
}

export type LetsEncryptRequestResult =
  | { ok: false; error: LetsEncryptRefusal; message?: string }
  | { ok: true; outcome: 'waiting'; dns: HostingDnsReport }
  | { ok: true; outcome: 'pinned'; tlsId: string; dns: HostingDnsReport; created: boolean }

type RequestParams = {
  store: LetsEncryptStore
  lookup: DnsLookup
  now: Date
  hosting: LetsEncryptHostingRecord
  acmeEnabled: boolean
}

function readHostnames(options: unknown): string[] {
  return parseHostingOptions(options)?.hostnames ?? []
}

async function pinCertificate(
  params: RequestParams,
  names: string[],
  dns: HostingDnsReport
): Promise<LetsEncryptRequestResult> {
  const { store, hosting } = params
  const existing = await store.findManagedCertificate(hosting.organizationId, names)
  const tlsId = existing ?? (await store.createManagedCertificate(hosting.organizationId, names))
  await store.saveHosting(hosting.id, {
    tlsId,
    metadata: withPendingLetsEncrypt(hosting.metadata, null),
  })
  return { ok: true, outcome: 'pinned', tlsId, dns, created: existing === null }
}

async function rememberWaiting(
  params: RequestParams,
  dns: HostingDnsReport
): Promise<LetsEncryptRequestResult> {
  const previous = readPendingLetsEncrypt(params.hosting.metadata)
  const pending: PendingLetsEncrypt = {
    requestedAt: previous?.requestedAt ?? params.now.toISOString(),
    dns,
  }
  await params.store.saveHosting(params.hosting.id, {
    metadata: withPendingLetsEncrypt(params.hosting.metadata, pending),
  })
  return { ok: true, outcome: 'waiting', dns }
}

/**
 * The button. Refuses what can never work, checks DNS on every name the
 * hosting's www setting adds (so "www.<name> does not point here yet" shows up
 * as a waiting name rather than a silent failed issuance), then either pins a
 * certificate (DNS ready) or remembers the request for the sweep (DNS not
 * ready). Clicking again repeats the whole thing and changes nothing twice.
 */
export async function requestLetsEncrypt(params: RequestParams): Promise<LetsEncryptRequestResult> {
  const options = parseHostingOptions(params.hosting.options)
  const hostnames = readHostnames(params.hosting.options)
  const refusal = letsEncryptRefusal({
    acmeEnabled: params.acmeEnabled,
    protocol: resolveHostingProtocol(options),
    bind: resolveHostingBind(options),
    hostnames,
  })
  if (refusal !== null) return { ok: false, error: refusal }

  const www = readHostingWwwMode(params.hosting.options)
  if (www !== 'off') {
    const conflict = wwwRedirectConflict(
      hostnames,
      await params.store.otherWebHostnames(params.hosting)
    )
    if (conflict !== null) {
      return {
        ok: false,
        error: 'www_redirect_conflict',
        message: wwwRedirectConflictMessage(conflict),
      }
    }
  }

  const names = letsEncryptNames(hostnames, www)
  const expected = await params.store.expectedAddresses(params.hosting)
  const dns = await checkHostingDns({
    hostnames: names,
    expectedAddresses: expected,
    lookup: params.lookup,
    now: params.now,
  })
  return dns.ready ? pinCertificate(params, names, dns) : rememberWaiting(params, dns)
}

export type PendingRetryResult = 'pinned' | 'waiting' | 'expired' | 'refused'

/**
 * One sweep step for a hosting with a waiting request. A request older than the
 * limit, or one the rules no longer allow (the organization switched Let's
 * Encrypt off, hostnames changed), is dropped.
 */
export async function retryPendingLetsEncrypt(params: RequestParams): Promise<PendingRetryResult> {
  const pending = readPendingLetsEncrypt(params.hosting.metadata)
  if (pending === null) return 'refused'
  const dropPending = async (outcome: 'expired' | 'refused'): Promise<PendingRetryResult> => {
    await params.store.saveHosting(params.hosting.id, {
      metadata: withPendingLetsEncrypt(params.hosting.metadata, null),
    })
    return outcome
  }
  if (isPendingExpired(pending, params.now)) return dropPending('expired')
  const result = await requestLetsEncrypt(params)
  if (!result.ok) return dropPending('refused')
  return result.outcome
}
