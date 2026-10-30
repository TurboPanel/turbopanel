/**
 * The two checks that run beside the DNS lookup before a certificate is
 * ordered: does port 80 answer from the internet, and does a CAA record let
 * Let's Encrypt issue. Let's Encrypt fetches its check file over port 80 and
 * reads CAA itself, so a miss here is a failed order (and a step closer to its
 * limit of five failed checks per name per hour) that the panel can see
 * coming.
 *
 * Both probes are injected like the DNS lookup: tests never touch the network,
 * Deno uses its own resolver, and Workers (no DNS API, no fetch to an IP
 * literal) uses DNS-over-HTTPS and a plain fetch of the name.
 */

import { DOH_ENDPOINT, DOH_TIMEOUT_MS } from '../../lib/http/doh-resolve.ts'

/** One CAA record, as Deno's resolver returns it. */
export type CaaRecord = { critical: boolean; tag: string; value: string }

/** CAA records at exactly `name`; an empty list when there are none (or the name does not exist). */
export type CaaLookup = (name: string) => Promise<CaaRecord[]>

/** Whether port 80 answers for `hostname`, and the reason when it does not. */
export type Port80Probe = (hostname: string) => Promise<{ open: boolean; error?: string }>

/** The certificate authority's CAA identity. */
export const LETS_ENCRYPT_CAA_DOMAIN = 'letsencrypt.org'

const PORT80_TIMEOUT_MS = 5_000
const CAA_RR_TYPE = 257
const NOERROR = 0
const NXDOMAIN = 3
/** Cloudflare's own "could not reach the origin" answers (a proxied name whose server is down). */
const EDGE_UNREACHABLE = new Set([520, 521, 522, 523, 524, 525, 526, 530])

/** `0 issue "letsencrypt.org"` or the generic `\# 22 00 05 69 73 ...` form. */
export function parseCaaData(data: string): CaaRecord | null {
  const text = data.trim()
  if (text.startsWith('\\#')) return parseGenericCaa(text)
  const match = /^(\d+)\s+([A-Za-z0-9]+)\s+(.*)$/.exec(text)
  if (!match) return null
  const value = match[3].trim().replace(/^"(.*)"$/, '$1')
  return { critical: (Number(match[1]) & 128) !== 0, tag: match[2].toLowerCase(), value }
}

function parseGenericCaa(text: string): CaaRecord | null {
  const hex = text.split(/\s+/).slice(2).join('')
  if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const bytes = hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16))
  const tagLength = bytes[1]
  if (bytes.length < 2 + tagLength) return null
  const decode = (part: number[]) => String.fromCodePoint(...part)
  return {
    critical: (bytes[0] & 128) !== 0,
    tag: decode(bytes.slice(2, 2 + tagLength)).toLowerCase(),
    value: decode(bytes.slice(2 + tagLength)),
  }
}

/** CAA over DNS-over-HTTPS (Workers). "No such name" is an empty answer; any other failure throws. */
export async function dohCaaLookup(name: string): Promise<CaaRecord[]> {
  const query = new URLSearchParams({ name, type: 'CAA' })
  const response = await fetch(`${DOH_ENDPOINT}?${query}`, {
    headers: { accept: 'application/dns-json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`doh: CAA lookup failed with HTTP ${response.status}`)
  }
  const reply = (await response.json()) as { Status?: unknown; Answer?: unknown }
  if (reply.Status === NXDOMAIN) return []
  if (reply.Status !== NOERROR) throw new Error(`doh: CAA lookup answered ${String(reply.Status)}`)
  const answers = Array.isArray(reply.Answer)
    ? (reply.Answer as Array<Record<string, unknown>>)
    : []
  return answers.flatMap((answer) => {
    if (answer.type !== CAA_RR_TYPE || typeof answer.data !== 'string') return []
    const record = parseCaaData(answer.data)
    return record ? [record] : []
  })
}

type DenoCaaResolve = (name: string, recordType: 'CAA') => Promise<CaaRecord[]>

/** Deno's resolver where there is one ("not found" is an empty answer), DNS-over-HTTPS otherwise. */
export function runtimeCaaLookup(): CaaLookup {
  const deno = (globalThis as { Deno?: { resolveDns?: unknown } }).Deno
  if (typeof deno?.resolveDns !== 'function') return dohCaaLookup
  const resolve = deno.resolveDns as DenoCaaResolve
  return async (name) => {
    try {
      return await resolve(name, 'CAA')
    } catch (err) {
      if (err instanceof Error && err.name === 'NotFound') return []
      throw err
    }
  }
}

export type CaaVerdict =
  | { allowed: true }
  | { allowed: false; recordAt: string }
  /** The lookup failed, so nothing is known; never blocks on its own. */
  | { allowed: null }

/** `a.b.example.com` → `a.b.example.com`, `b.example.com`, `example.com`, `com`. */
function selfAndParents(hostname: string): string[] {
  const labels = hostname.replace(/\.$/, '').split('.')
  return labels.map((_, index) => labels.slice(index).join('.'))
}

/** Does this record set let Let's Encrypt issue a certificate for a plain (not wildcard) name? */
export function caaSetAllowsLetsEncrypt(records: readonly CaaRecord[]): boolean {
  const known = new Set(['issue', 'issuewild', 'iodef'])
  if (records.some((record) => record.critical && !known.has(record.tag))) return false
  const issue = records.filter((record) => record.tag === 'issue')
  if (issue.length === 0) return true
  return issue.some(
    (record) => record.value.split(';')[0].trim().toLowerCase() === LETS_ENCRYPT_CAA_DOMAIN
  )
}

/**
 * The CAA rule as the authority applies it: the closest name (the name itself,
 * then each parent) that has any CAA records decides; no records anywhere means
 * any authority may issue.
 */
export async function checkCaa(lookup: CaaLookup, hostname: string): Promise<CaaVerdict> {
  for (const name of selfAndParents(hostname)) {
    let records: CaaRecord[]
    try {
      records = await lookup(name)
    } catch {
      return { allowed: null }
    }
    if (records.length === 0) continue
    return caaSetAllowsLetsEncrypt(records) ? { allowed: true } : { allowed: false, recordAt: name }
  }
  return { allowed: true }
}

/** The tail of an error chain, clipped (`fetch failed: Connection refused (os error 111)`). */
function errorLine(err: unknown): string {
  const top = err instanceof Error ? err.message : String(err)
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : ''
  const text = cause && cause !== top ? `${top}: ${cause}` : top
  return text.length > 200 ? text.slice(-200) : text
}

/**
 * Port 80, the way the authority reaches it: an HTTP request to the name on
 * the well-known check path. Any answer at all (a 404 included) means port 80
 * is reachable; a refused or timed-out connection, or Cloudflare's own
 * "origin unreachable" answer, means it is not. Redirects are not followed.
 */
export function runtimePort80Probe(fetchImpl: typeof fetch = fetch): Port80Probe {
  return async (hostname) => {
    try {
      const response = await fetchImpl(
        `http://${hostname}/.well-known/acme-challenge/turbopanel-reachability-check`,
        { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PORT80_TIMEOUT_MS) }
      )
      await response.body?.cancel()
      if (EDGE_UNREACHABLE.has(response.status)) {
        return { open: false, error: `the proxy in front answered HTTP ${response.status}` }
      }
      return { open: true }
    } catch (err) {
      return { open: false, error: errorLine(err) }
    }
  }
}

/** The pre-check probes besides the A/AAAA lookup; a missing probe is skipped. */
export type CertificatePrecheckProbes = {
  caaLookup?: CaaLookup
  port80?: Port80Probe
}

/**
 * The probes a route or the sweep runs. The runtime ones, unless the caller
 * injected its own DNS lookup (a test): then only the probes it injected run,
 * so a test never reaches the network by accident.
 */
export function precheckProbes(deps: {
  lookup?: unknown
  caaLookup?: CaaLookup
  port80?: Port80Probe
}): CertificatePrecheckProbes {
  const injected = deps.lookup !== undefined
  const caaLookup = deps.caaLookup ?? (injected ? undefined : runtimeCaaLookup())
  const port80 = deps.port80 ?? (injected ? undefined : runtimePort80Probe())
  return { ...(caaLookup ? { caaLookup } : {}), ...(port80 ? { port80 } : {}) }
}
