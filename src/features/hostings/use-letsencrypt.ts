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
  pendingLetsEncryptPatch,
  wwwRedirectConflict,
  wwwRedirectConflictMessage,
} from './hosting-certificate.ts'
import { type DnsLookup, checkHostingDns } from './hosting-dns-check.ts'
import { isComposeAutomaticTlsHosting, isComposeOwnedHosting } from './hosting-compose-owner.ts'
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
  /** When a waiting request was made (`hosting.pending_at`); null when none. */
  pendingAt: string | null
}

export type LetsEncryptStore = {
  /**
   * Run `use` in one transaction under the locks that keep a found or created
   * certificate from being removed before the hosting pins it, with a store
   * bound to that transaction.
   */
  withCertificateLock<T>(
    hosting: LetsEncryptHostingRecord,
    use: (store: LetsEncryptStore) => Promise<T>
  ): Promise<T>
  /** The public addresses of the server this hosting is deployed to (the pinned IP wins). */
  expectedAddresses(hosting: LetsEncryptHostingRecord): Promise<string[]>
  /** Hostnames of the other web hostings in this hosting's environment (what a www twin must not collide with). */
  otherWebHostnames(hosting: LetsEncryptHostingRecord): Promise<string[]>
  /**
   * The organization's managed Let's Encrypt row for `names`, created when
   * there is none: the live row whose names equal them, else one that already
   * covers every one of them. Serialized per organization, so two requests at
   * once settle on one row.
   */
  managedCertificateFor(
    organizationId: string,
    names: readonly string[]
  ): Promise<{ id: string; created: boolean }>
  saveHosting(
    hostingId: string,
    patch: {
      tlsId?: string
      options?: Record<string, unknown>
      metadata?: Record<string, unknown>
      pendingAt?: string | null
    }
  ): Promise<void>
}

export type LetsEncryptRequestResult =
  | { ok: false; error: LetsEncryptRefusal; message?: string }
  | { ok: true; outcome: 'waiting'; dns: HostingDnsReport }
  | {
      ok: true
      outcome: 'pinned'
      tlsId: string
      dns: HostingDnsReport
      created: boolean
      /** The hosting points at a different certificate row than before (a new pin). */
      changed: boolean
    }

type RequestParams = {
  store: LetsEncryptStore
  lookup: DnsLookup
  now: Date
  hosting: LetsEncryptHostingRecord
  acmeEnabled: boolean
}

/** Compose owns this row and chose a certificate other than Let's Encrypt, so the panel must not pin one. */
function composeOwnsAnotherCertificate(metadata: unknown): boolean {
  return isComposeOwnedHosting(metadata) && !isComposeAutomaticTlsHosting(metadata)
}

function readHostnames(options: unknown): string[] {
  return parseHostingOptions(options)?.hostnames ?? []
}

async function pinCertificate(
  params: RequestParams,
  names: string[],
  dns: HostingDnsReport
): Promise<LetsEncryptRequestResult> {
  const { hosting } = params
  // Found or created and pinned in one transaction, so no cleanup can remove
  // the row between the two.
  return await params.store.withCertificateLock(hosting, async (store) => {
    const { id: tlsId, created } = await store.managedCertificateFor(hosting.organizationId, names)
    const changed = hosting.tlsId !== tlsId
    // A repeat click on a hosting already pinned to this row writes nothing, so
    // it neither looks like a new change nor sends the certificate out again.
    if (changed || readPendingLetsEncrypt(hosting) !== null) {
      await store.saveHosting(hosting.id, {
        ...(changed ? { tlsId } : {}),
        ...pendingLetsEncryptPatch(hosting.metadata, null),
      })
    }
    return { ok: true as const, outcome: 'pinned' as const, tlsId, dns, created, changed }
  })
}

async function rememberWaiting(
  params: RequestParams,
  dns: HostingDnsReport
): Promise<LetsEncryptRequestResult> {
  const previous = readPendingLetsEncrypt(params.hosting)
  const pending: PendingLetsEncrypt = {
    requestedAt: previous?.requestedAt ?? params.now.toISOString(),
    dns,
  }
  await params.store.saveHosting(params.hosting.id, {
    ...pendingLetsEncryptPatch(params.hosting.metadata, pending),
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
  const www = readHostingWwwMode(params.hosting.options)
  const refusal = letsEncryptRefusal({
    acmeEnabled: params.acmeEnabled,
    protocol: resolveHostingProtocol(options),
    bind: resolveHostingBind(options),
    hostnames,
    www,
  })
  if (refusal !== null) return { ok: false, error: refusal }

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

/** `unchanged`: DNS is ready and the hosting was already pinned to the matching row. */
export type PendingRetryResult = 'pinned' | 'unchanged' | 'waiting' | 'expired' | 'refused'

/**
 * One sweep step for a hosting with a waiting request. A request older than the
 * limit, or one the rules no longer allow (the organization switched Let's
 * Encrypt off, hostnames changed, or compose now owns the row and no longer
 * asks for `tls.mode: automatic`), is dropped.
 */
export async function retryPendingLetsEncrypt(params: RequestParams): Promise<PendingRetryResult> {
  const pending = readPendingLetsEncrypt(params.hosting)
  if (pending === null) return 'refused'
  const dropPending = async (outcome: 'expired' | 'refused'): Promise<PendingRetryResult> => {
    await params.store.saveHosting(params.hosting.id, {
      ...pendingLetsEncryptPatch(params.hosting.metadata, null),
    })
    return outcome
  }
  if (isPendingExpired(pending, params.now)) return dropPending('expired')
  if (composeOwnsAnotherCertificate(params.hosting.metadata)) return dropPending('refused')
  const result = await requestLetsEncrypt(params)
  if (!result.ok) return dropPending('refused')
  if (result.outcome === 'pinned' && !result.changed) return 'unchanged'
  return result.outcome
}
