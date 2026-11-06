/**
 * A/AAAA lookups over DNS-over-HTTPS, for the runtime that has no resolver.
 *
 * The Workers runtime exposes no DNS API, so `resolveOutboundHost`
 * (`outbound-url.ts`) asks Cloudflare's public resolver (1.1.1.1, reached by
 * its `cloudflare-dns.com` name: Workers refuse a `fetch` to an IP literal)
 * through its JSON API instead. Only the answers' addresses are returned;
 * judging them is the caller's job, with the same classifier the Deno
 * resolver's answers go through.
 *
 * Every failure throws — a non-2xx reply (a redirect included), a body that is not the expected
 * JSON, any `Status` but NOERROR (NXDOMAIN included), an address that does
 * not parse, a timeout. The caller decides what a failure means; at fetch
 * time it refuses the request.
 */
import { normalizeIpAddress } from '../ip-address.ts'

export const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'
/** Per-lookup budget, on top of whatever deadline the caller passes. */
export const DOH_TIMEOUT_MS = 3_000

export type DohRecordType = 'A' | 'AAAA'

/** RR type numbers in the JSON API's `Answer[].type`. */
const RR_TYPE: Record<DohRecordType, number> = { A: 1, AAAA: 28 }
/** RCODE 0. */
const NOERROR = 0

type DohAnswer = { type?: unknown; data?: unknown }
export type DohReply = { Status?: unknown; Answer?: unknown }

export type DohLookup = (
  name: string,
  recordType: DohRecordType,
  options?: { signal?: AbortSignal }
) => Promise<string[]>

/**
 * The address records of `recordType` in a reply. CNAME (and any other type)
 * entries in the chain are skipped: only the final addresses are dialed.
 */
function addressesIn(reply: DohReply, recordType: DohRecordType): string[] {
  if (reply.Status !== NOERROR) {
    throw new Error(`doh: ${recordType} lookup answered status ${String(reply.Status)}`)
  }
  const answers: DohAnswer[] = Array.isArray(reply.Answer) ? reply.Answer : []
  return answers
    .filter((answer) => answer.type === RR_TYPE[recordType])
    .map((answer) => {
      const address = typeof answer.data === 'string' ? normalizeIpAddress(answer.data) : null
      if (address === null) throw new Error(`doh: unparseable ${recordType} answer`)
      return address
    })
}

/**
 * One DNS-over-HTTPS query through the runtime's `fetch`, answered as the
 * JSON API's reply. A non-2xx reply (a redirect included) throws; reading the
 * answers is the caller's job.
 */
export async function dohQuery(
  name: string,
  recordType: string,
  options: { signal?: AbortSignal } = {}
): Promise<DohReply> {
  const timeout = AbortSignal.timeout(DOH_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const query = new URLSearchParams({ name, type: recordType })
  const response = await fetch(`${DOH_ENDPOINT}?${query}`, {
    headers: { accept: 'application/dns-json' },
    // Never 'error': the Workers runtime rejects it outright ("must be one
    // of follow or manual"), which failed every lookup on hosted. With
    // 'manual' a redirect comes back as a 3xx, refused just below.
    redirect: 'manual',
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`doh: ${recordType} lookup failed with HTTP ${response.status}`)
  }
  return (await response.json()) as DohReply
}

/** One A or AAAA lookup through the runtime's `fetch`. */
export const dohLookup: DohLookup = async (name, recordType, options = {}) =>
  addressesIn(await dohQuery(name, recordType, options), recordType)
