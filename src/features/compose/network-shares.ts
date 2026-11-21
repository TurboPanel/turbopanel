/**
 * Network share volumes: a top-level Compose volume that mounts an SMB share
 * (`driver_opts.type` of `cifs` or `smb3`) instead of plain Docker storage.
 *
 * A share is not a host-level reach: it never names a path on the daemon host,
 * so `./host-access.ts` leaves it out. It has its own gate: the target server
 * must allow network shares (`server.options.networkShares`) and the deploying
 * user must hold the capability to deploy them. Both are decided where server
 * and actor context exist (the deploy planner and route); this module only says
 * *which* volumes are shares, and stays pure.
 *
 * `device` and `o` may carry `{$KEY}` references to project variables (the
 * share address, the credentials). `./apply-variables.ts` fills them in; this
 * module never sees a value.
 */

/** Filesystem types that make a local volume an SMB mount. */
const NETWORK_SHARE_TYPES = new Set(['cifs', 'smb3'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * True when `driver_opts` describe an SMB share: a `cifs` / `smb3` type, no
 * bind flag, and a `device` of `//host/share` or an interpolated `{$KEY}` value (a host path
 * like `/etc`, or no device, is not a share).
 */
export function isNetworkShareDriverOpts(opts: unknown): boolean {
  if (!isRecord(opts)) return false
  const type = typeof opts.type === 'string' ? opts.type.trim().toLowerCase() : ''
  if (!NETWORK_SHARE_TYPES.has(type)) return false
  const o = typeof opts.o === 'string' ? opts.o : ''
  const flags = new Set(o.split(',').map((flag) => flag.trim().toLowerCase()))
  if (flags.has('bind') || flags.has('rbind')) return false
  if (typeof opts.device !== 'string') return false
  // A share address is `//host/share` (or an interpolated value). Anything
  // else, a host path or an odd address, stays an ordinary mount.
  const device = opts.device.trim()
  if (!device.startsWith('//') && !device.startsWith('{$')) return false
  return true
}

/** True when the type alone says SMB, whatever else the volume does. */
export function hasNetworkShareType(opts: unknown): boolean {
  if (!isRecord(opts) || typeof opts.type !== 'string') return false
  return NETWORK_SHARE_TYPES.has(opts.type.trim().toLowerCase())
}

/** Names of the top-level volumes in `doc` that mount an SMB share. */
export function findNetworkShareVolumes(doc: unknown): string[] {
  if (!isRecord(doc) || !isRecord(doc.volumes)) return []
  const names: string[] = []
  for (const [name, entry] of Object.entries(doc.volumes)) {
    if (isRecord(entry) && hasNetworkShareType(entry.driver_opts)) names.push(name)
  }
  return names
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  // UTF-16 code-unit order, never locale order: a recorded approval has to
  // match byte for byte on every host.
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : Number(a > b)))) {
    out[key] = sortKeys(value[key])
  }
  return out
}

/**
 * The authored share volumes as a stable string (`''` when there are none).
 * Unresolved `{$KEY}` references stay as written, so changing a variable's value
 * never voids an approval; adding, removing or re-pointing a share does.
 */
export function networkSharesCanonical(doc: unknown): string {
  const names = findNetworkShareVolumes(doc)
  if (names.length === 0) return ''
  const volumes = (doc as { volumes: Record<string, unknown> }).volumes
  const entries = names
    .map((name) => [name, volumes[name]] as const)
    .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
  return JSON.stringify(sortKeys(entries))
}

/** SHA-256 hex of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 hex of {@link networkSharesCanonical}, or `null` when no volume is a share. */
export async function networkSharesFingerprint(doc: unknown): Promise<string | null> {
  const canonical = networkSharesCanonical(doc)
  return canonical === '' ? null : await sha256Hex(canonical)
}
