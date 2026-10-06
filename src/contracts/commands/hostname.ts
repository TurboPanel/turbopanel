export const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

export const HOSTNAME_MAX_LENGTH = 253

const SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/

export function isValidHostname(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0) return false
  if (value.length > HOSTNAME_MAX_LENGTH) return false
  if (/[A-Z]/.test(value)) return false
  if (/\s/.test(value)) return false
  if (SHELL_METACHAR_RE.test(value)) return false
  return HOSTNAME_RE.test(value)
}

const WWW_PREFIX = 'www.'

/**
 * The other spelling of a site name for the "send www to the main name" option:
 * `www.example.com` for `example.com`, and `example.com` for `www.example.com`.
 * Returns `null` when no valid name results (a bare `www`, a name that would be
 * too long once `www.` is added).
 */
export function wwwSiblingHostname(hostname: string): string | null {
  const sibling = hostname.startsWith(WWW_PREFIX)
    ? hostname.slice(WWW_PREFIX.length)
    : WWW_PREFIX + hostname
  return isValidHostname(sibling) ? sibling : null
}

/**
 * How a hosting treats the www spelling of each of its hostnames. `off` (the
 * wire omits it) answers only on the name as written; `both` serves the site on
 * both spellings; `www-to-root` serves it on the bare name and permanently
 * redirects `www.` to it; `root-to-www` serves it on `www.` and redirects the
 * bare name there. The direction is about the names themselves, not about which
 * one was typed: `www-to-root` on `www.example.com` serves `example.com`.
 * Twin of `turbopaneld/src/contracts/commands-contracts.ts`.
 */
export type HostingWwwMode = 'off' | 'both' | 'www-to-root' | 'root-to-www'

export const HOSTING_WWW_MODES: readonly HostingWwwMode[] = [
  'off',
  'both',
  'www-to-root',
  'root-to-www',
]

export function isHostingWwwMode(value: unknown): value is HostingWwwMode {
  return typeof value === 'string' && (HOSTING_WWW_MODES as readonly string[]).includes(value)
}

/** What one hostname turns into under a www mode. */
export type HostingWwwNames = {
  /** Names the site answers on (the hostname as written comes first). */
  serve: string[]
  /** A name that only redirects, and where it sends the visitor. */
  redirect: { from: string; to: string } | null
}

/**
 * Expand one hostname under a www mode. `null` when the mode needs the other
 * spelling and that spelling is not a valid hostname (a wildcard, say).
 */
export function hostingWwwNames(
  hostname: string,
  mode: HostingWwwMode = 'off'
): HostingWwwNames | null {
  if (mode === 'off') return { serve: [hostname], redirect: null }
  const sibling = wwwSiblingHostname(hostname)
  if (sibling === null) return null
  if (mode === 'both') return { serve: [hostname, sibling], redirect: null }
  const typedIsWww = hostname.startsWith(WWW_PREFIX)
  const root = typedIsWww ? sibling : hostname
  const www = typedIsWww ? hostname : sibling
  return mode === 'www-to-root'
    ? { serve: [root], redirect: { from: www, to: root } }
    : { serve: [www], redirect: { from: root, to: www } }
}

type WwwHosting = { hostnames: readonly string[]; www?: HostingWwwMode }

/**
 * Every name a hosting's site answers on: each hostname as written, swapped or
 * joined by its other spelling under the hosting's `www` mode. Names a mode
 * cannot expand (refused by validation) stay as written.
 */
export function hostingServedNames(hosting: WwwHosting): string[] {
  return hosting.hostnames.flatMap(
    (hostname) => hostingWwwNames(hostname, hosting.www)?.serve ?? [hostname]
  )
}

/** The names a hosting's `www` mode only redirects, with their targets. */
export function hostingWwwRedirects(hosting: WwwHosting): { from: string; to: string }[] {
  return hosting.hostnames.flatMap((hostname) => {
    const redirect = hostingWwwNames(hostname, hosting.www)?.redirect
    return redirect ? [redirect] : []
  })
}

/** Every name a certificate for the hosting must cover: served and redirected. */
export function hostingCertificateNames(hosting: WwwHosting): string[] {
  const names = [
    ...hostingServedNames(hosting),
    ...hostingWwwRedirects(hosting).map((redirect) => redirect.from),
  ]
  return [...new Set(names)]
}

export function assertValidHostname(value: unknown): asserts value is string {
  if (!isValidHostname(value)) {
    throw new Error('Invalid hostname')
  }
}
