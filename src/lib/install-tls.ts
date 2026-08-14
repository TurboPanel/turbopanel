/**
 * Decide whether an install/control-plane origin needs bootstrap insecure TLS
 * (`curl -k` / `TURBOPANEL_INSECURE_TLS=1`).
 *
 * Public HTTPS on port 443 (Cloudflare tunnel, Let's Encrypt, uploaded cert) is
 * trusted via the system store. The platform CA (self-signed Caddy listener) is
 * used for non-443 ports, loopback, private/link-local addresses, and reserved
 * LAN TLDs (.lan / .local / …).
 *
 * Let's Encrypt and uploaded certificates are operator opt-in on the origin;
 * this helper only classifies the URL the daemon will dial. It never implies
 * the control plane should obtain a public certificate on its own.
 */

const LOCAL_TLDS = new Set([
  'lan',
  'local',
  'internal',
  'home',
  'corp',
  'localhost',
])

function stripIpv6Brackets(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '')
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (!Number.isInteger(value) || value < 0 || value > 255) return null
    octets.push(value)
  }
  return octets
}

function isPrivateOrLoopbackIpv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === undefined || b === undefined) return false
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase()
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.includes(':')) {
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
    if (host.startsWith('fe80:')) return true
    // Unique local IPv6 (fc00::/7).
    if (host.startsWith('fc') || host.startsWith('fd')) return true
  }

  const octets = ipv4Octets(host)
  if (octets) return isPrivateOrLoopbackIpv4(octets)

  const tld = host.split('.').at(-1)
  return Boolean(tld && LOCAL_TLDS.has(tld))
}

/**
 * True when bootstrap should skip public TLS verification for this origin
 * (platform CA / self-signed). False for plaintext HTTP and for publicly
 * trusted HTTPS (tunnel, LE, uploaded cert on :443).
 */
export function installOriginNeedsInsecureTls(origin: string): boolean {
  const trimmed = origin.trim()
  if (!trimmed.startsWith('https://')) return false
  try {
    const url = new URL(trimmed)
    const port = url.port || '443'
    if (port !== '443') return true
    return isLoopbackOrPrivateHostname(url.hostname)
  } catch {
    return false
  }
}

/** Overlay artifact catalog on the same origin the installer was fetched from. */
export function formatInstanceDlBase(origin: string): string {
  return `${origin.replace(/\/$/, '')}/downloads/daemon`
}
