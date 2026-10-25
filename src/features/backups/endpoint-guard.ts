/**
 * Which endpoint URLs a backup copy target may use. An organization manager
 * picks the endpoint and a host sends signed requests to it, so addresses that
 * reach the host itself or the cloud metadata service are refused here when a
 * target is saved, and again by the daemon before it connects (the rules are
 * the same: `turbopaneld/src/backups/s3/endpoint-guard.ts`).
 */

const BLOCKED_NAMES = new Set(['localhost', 'metadata.google.internal', 'metadata'])

function ipv4Parts(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every((p) => p <= 255) ? parts : null
}

function isLoopbackOrLinkLocalV4(p: number[]): boolean {
  return p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254)
}

function isPrivateV4(p: number[]): boolean {
  const [a, b] = p as [number, number]
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

function ipv6Class(host: string): 'loopback' | 'private' | 'other' {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    h === '::1' ||
    h === '::' ||
    h.startsWith('fe80:') ||
    h.startsWith('::ffff:127.') ||
    h.startsWith('::ffff:169.254.')
  ) {
    return 'loopback'
  }
  if (h.startsWith('fc') || h.startsWith('fd')) {
    return h.startsWith('fd00:ec2') ? 'loopback' : 'private'
  }
  return 'other'
}

function endpointShapeRefusal(url: URL): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'The endpoint must start with https://'
  }
  if (url.username || url.password) {
    return 'The endpoint must not contain a user name or password'
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return 'The endpoint must be a host name only, without a path'
  }
  return null
}

/** A plain reason when the endpoint may not be used, else null. */
export function endpointRefusal(endpoint: string): string | null {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return 'The endpoint is not a valid URL'
  }
  const shape = endpointShapeRefusal(url)
  if (shape) return shape
  const host = url.hostname.toLowerCase()
  const v4 = ipv4Parts(host)
  const v6 = host.startsWith('[') ? ipv6Class(host) : null
  const loopback =
    (v4 !== null && isLoopbackOrLinkLocalV4(v4)) ||
    v6 === 'loopback' ||
    BLOCKED_NAMES.has(host) ||
    host.endsWith('.localhost')
  if (loopback) {
    return 'The endpoint points at a server itself or a metadata address, which is not allowed'
  }
  if (url.protocol === 'http:') {
    const priv = (v4 !== null && isPrivateV4(v4)) || v6 === 'private'
    return priv
      ? null
      : 'Plain http:// is only allowed for an address on a private network; use https://'
  }
  return null
}
