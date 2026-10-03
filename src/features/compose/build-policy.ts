/**
 * What a Compose `build:` may ask of the engine that builds it.
 *
 * Until builds leave the rootful engine (rootless BuildKit, phase 2 of the
 * unprivileged-builds design), a Dockerfile `RUN` step runs as root on the
 * daemon host's Docker engine. Anyone who can deploy may define a build, so
 * these rules have to hold against a hostile project member — and unlike
 * `./host-access.ts` they carry **no organization opt-in**: nothing here is a
 * feature an owner can turn on, so a match is a refusal, always.
 *
 * - `network` other than `default` / `none` (`host` shares the host's
 *   network stack, including services bound to loopback);
 * - `privileged`, `entitlements` (`network.host`, `security.insecure`);
 * - `ssh` agent forwarding (`default`, or an id with no key path), and SSH key
 *   paths outside the service's directory;
 * - `secrets` whose top-level `file` is outside the service's directory;
 * - `extra_hosts` mapping a name to the host (`host-gateway`), a loopback,
 *   link-local, unspecified or cloud-metadata address;
 * - `context`, `dockerfile` and `additional_contexts` that leave the service's
 *   directory (absolute, `~`, `..`, interpolated), or a remote context whose
 *   host is internal (a non-public IP literal, `localhost`, a single-label or
 *   reserved name).
 *
 * Lexical, like `./host-access.ts`: the daemon repeats these rules on the
 * resolved model and resolves every build path on the host, which is what
 * catches a symlink (turbopaneld `compose-build-policy.ts`,
 * `compose-host-paths.ts`). A DNS name that resolves to an internal address
 * is not caught here; the builder's own network is what bounds that.
 *
 * Pure and org-blind, like the rest of `src/features/compose/`.
 */

import { ipAddressScope, ipToBigInt, normalizeIpAddress } from '../../lib/ip-address.ts'
import { hostIsReserved, unbracket } from '../../lib/http/outbound-url.ts'
import { outsideReason } from './host-access.ts'
import { resolveComposeTags } from './tags.ts'

/** One machine-readable code per rule, so a caller never keys off the prose. */
export type BuildRefusalCode =
  | 'build_network_refused'
  | 'build_privileged_refused'
  | 'build_entitlements_refused'
  | 'build_ssh_refused'
  | 'build_secret_outside_project'
  | 'build_extra_host_internal'
  | 'build_context_outside_project'
  | 'build_context_internal_url'

const BUILD_REFUSAL_CODES: ReadonlySet<string> = new Set<BuildRefusalCode>([
  'build_network_refused',
  'build_privileged_refused',
  'build_entitlements_refused',
  'build_ssh_refused',
  'build_secret_outside_project',
  'build_extra_host_internal',
  'build_context_outside_project',
  'build_context_internal_url',
])

export function isBuildRefusalCode(code: string | undefined): code is BuildRefusalCode {
  return code !== undefined && BUILD_REFUSAL_CODES.has(code)
}

export type BuildRefusal = {
  code: BuildRefusalCode
  /** Dot path, `[i]` for sequence items — the same shape the linter reports. */
  path: string
  /** YAML path segments, for resolving the node (and its line). */
  segments: Array<string | number>
  message: string
}

const NO_OPT_IN = 'builds may not do this, whatever the organization allows'

/** Build networks BuildKit offers that reach nothing on the host. */
const ALLOWED_BUILD_NETWORKS = new Set(['default', 'none'])

/**
 * Cloud metadata endpoints that sit in ranges `ipAddressScope` calls private:
 * AWS's IPv6 endpoint (`fd00:ec2::254`) and Alibaba's (`100.100.100.200`).
 * Kept as numbers: link-local metadata (`169.254.169.254`) is caught by scope.
 */
const METADATA_ADDRESSES: ReadonlySet<bigint> = new Set([
  0xfd00_0ec2_0000_0000_0000_0000_0000_0254n,
  0x6464_64c8n,
])

/** A host label spelled the way `inet_aton` reads a number (`0x7f`, `017`, `2130706433`). */
const NUMERIC_LABEL_RE = /^(?:0x[0-9a-f]*|\d+)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function joinPath(segments: ReadonlyArray<string | number>): string {
  let out = ''
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? segment : `.${segment}`
  }
  return out
}

class Refusals {
  readonly found: BuildRefusal[] = []

  add(code: BuildRefusalCode, segments: Array<string | number>, what: string, reason: string) {
    this.found.push({
      code,
      path: joinPath(segments),
      segments,
      message: `${what} ${reason} — ${NO_OPT_IN}`,
    })
  }

  /** A host path the build reads: refused unless relative and inside. */
  path(
    code: BuildRefusalCode,
    segments: Array<string | number>,
    what: string,
    value: unknown
  ): void {
    if (typeof value !== 'string') {
      this.add(code, segments, what, 'is not a plain path, so it cannot be checked')
      return
    }
    const reason = outsideReason(value)
    if (reason) this.add(code, segments, `${what} \`${value}\``, reason)
  }
}

/** Why an address is one a build must not be pointed at, or `null`. */
export function internalAddressReason(value: string): string | null {
  const address = normalizeIpAddress(value)
  if (address === null) return 'is not an IP address, so where it points cannot be checked'
  const numeric = ipToBigInt(address)
  if (numeric !== null && METADATA_ADDRESSES.has(numeric)) {
    return 'is a cloud metadata endpoint'
  }
  const scope = ipAddressScope(address)
  if (scope === 'loopback') return 'is a loopback address on the build host'
  if (scope === 'link-local') return 'is link-local, where cloud metadata endpoints live'
  if (scope === null) return 'is not a unicast host address'
  return null
}

/** Why a remote host is internal, or `null` when it may be fetched from. */
function internalHostReason(rawHost: string): string | null {
  const host = unbracket(rawHost.toLowerCase())
  if (host === '') return 'names no host'
  if (normalizeIpAddress(host) !== null) {
    const reason = internalAddressReason(host)
    if (reason) return reason
    return ipAddressScope(host) === 'public' ? null : 'is a private address'
  }
  if (host.split('.').every((label) => NUMERIC_LABEL_RE.test(label))) {
    return 'is a numeric host that resolves to an address this check cannot see'
  }
  return hostIsReserved(host) ? 'names an internal host' : null
}

/** The host a URL-shaped context fetches from, or `undefined` when it cannot be parsed. */
function remoteHost(value: string): string | undefined {
  if (value.startsWith('git@')) {
    const colon = value.indexOf(':')
    return colon === -1 ? undefined : value.slice('git@'.length, colon)
  }
  try {
    return new URL(value).hostname
  } catch {
    return undefined
  }
}

/** Whether a context string names a remote source rather than a host path. */
function isRemoteContext(value: string): boolean {
  return (
    (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith('oci-layout://')) ||
    value.startsWith('git@') ||
    /^github\.com\//i.test(value)
  )
}

/** A context or additional context: a host path, a remote source, or neither. */
function checkContext(
  out: Refusals,
  segments: Array<string | number>,
  what: string,
  value: unknown
) {
  if (typeof value === 'string' && value.startsWith('oci-layout://')) {
    out.path('build_context_outside_project', segments, what, value.slice('oci-layout://'.length))
    return
  }
  if (typeof value !== 'string' || !isRemoteContext(value)) {
    out.path('build_context_outside_project', segments, what, value)
    return
  }
  if (/^github\.com\//i.test(value)) return
  const host = remoteHost(value)
  const reason =
    host === undefined
      ? 'cannot be parsed, so where it points cannot be checked'
      : internalHostReason(host)
  if (reason) out.add('build_context_internal_url', segments, `${what} \`${value}\``, reason)
}

/** `docker-image://`, `service:` and `target:` name an image or stage, not a path. */
function isImageOrStage(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith('docker-image://') ||
      value.startsWith('service:') ||
      value.startsWith('target:'))
  )
}

function checkAdditionalContexts(out: Refusals, at: Array<string | number>, contexts: unknown) {
  if (contexts === undefined || contexts === null) return
  if (!isRecord(contexts)) {
    out.add(
      'build_context_outside_project',
      [...at, 'additional_contexts'],
      'additional build contexts',
      'are not a mapping, so the paths they name cannot be checked'
    )
    return
  }
  for (const [name, value] of Object.entries(contexts)) {
    if (isImageOrStage(value)) continue
    checkContext(out, [...at, 'additional_contexts', name], 'additional build context', value)
  }
}

function checkPrivileges(
  out: Refusals,
  at: Array<string | number>,
  build: Record<string, unknown>
) {
  const network = build.network
  if (
    network !== undefined &&
    network !== null &&
    !(typeof network === 'string' && ALLOWED_BUILD_NETWORKS.has(network))
  ) {
    out.add(
      'build_network_refused',
      [...at, 'network'],
      `build network \`${typeof network === 'string' ? network : JSON.stringify(network)}\``,
      'is refused: only `default` and `none` keep the build off the host network'
    )
  }
  if (build.privileged !== undefined && build.privileged !== null && build.privileged !== false) {
    out.add(
      'build_privileged_refused',
      [...at, 'privileged'],
      'privileged build',
      'runs with full host privileges'
    )
  }
  if (build.entitlements !== undefined && build.entitlements !== null) {
    out.add(
      'build_entitlements_refused',
      [...at, 'entitlements'],
      'build entitlements',
      'grant the build host-level privileges'
    )
  }
}

type SshEntry = { at: Array<string | number>; id: string; path: unknown }

/** One `id` / `id=path` item; an `id` alone forwards the agent (empty path). */
function sshItem(at: Array<string | number>, item: unknown): SshEntry {
  if (typeof item !== 'string') return { at, id: '?', path: item }
  const eq = item.indexOf('=')
  return eq === -1
    ? { at, id: item, path: '' }
    : { at, id: item.slice(0, eq), path: item.slice(eq + 1) }
}

/** `ssh`: a list of `id` / `id=path`, a single one, or a mapping of id to path. */
function sshEntries(ssh: unknown): SshEntry[] {
  if (Array.isArray(ssh)) return ssh.map((item, index) => sshItem([index], item))
  if (isRecord(ssh)) {
    return Object.entries(ssh).map(([id, path]) => ({ at: [id], id, path: path ?? '' }))
  }
  return [sshItem([], ssh)]
}

function checkSsh(out: Refusals, at: Array<string | number>, ssh: unknown) {
  if (ssh === undefined || ssh === null) return
  for (const entry of sshEntries(ssh)) {
    const segments = [...at, 'ssh', ...entry.at]
    if (entry.path === '') {
      out.add(
        'build_ssh_refused',
        segments,
        `build ssh \`${entry.id}\``,
        "forwards the daemon's SSH agent into the build"
      )
    } else {
      out.path('build_ssh_refused', segments, `build ssh key \`${entry.id}\``, entry.path)
    }
  }
}

function secretSource(entry: unknown): unknown {
  return isRecord(entry) ? entry.source : entry
}

function checkSecrets(
  out: Refusals,
  at: Array<string | number>,
  secrets: unknown,
  topLevel: Record<string, unknown>
) {
  if (!Array.isArray(secrets)) return
  secrets.forEach((entry, index) => {
    const source = secretSource(entry)
    if (typeof source !== 'string') return
    const spec = topLevel[source]
    if (!isRecord(spec) || spec.file === undefined) return
    out.path(
      'build_secret_outside_project',
      [...at, 'secrets', index],
      `build secret \`${source}\` file`,
      spec.file
    )
  })
}

/** `extra_hosts`: a list of `name:ip` / `name=ip`, or a mapping of name to ip. */
function extraHostEntries(
  value: unknown
): Array<{ at: Array<string | number>; entry: string; ip: unknown }> {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item !== 'string') return { at: [index], entry: '?', ip: item }
      const eq = item.indexOf('=')
      const split = eq === -1 ? item.indexOf(':') : eq
      return { at: [index], entry: item, ip: split === -1 ? '' : item.slice(split + 1) }
    })
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([name, ip]) => ({ at: [name], entry: name, ip }))
  }
  return [{ at: [], entry: '?', ip: value }]
}

function extraHostReason(ip: unknown): string | null {
  if (typeof ip !== 'string') return 'is not an address, so where it points cannot be checked'
  const trimmed = ip.trim()
  if (trimmed.includes('$')) {
    return 'is interpolated, so where it points cannot be checked before deploy'
  }
  if (trimmed === 'host-gateway') return 'maps a name to the build host itself'
  return internalAddressReason(trimmed)
}

function checkExtraHosts(out: Refusals, at: Array<string | number>, value: unknown) {
  if (value === undefined || value === null) return
  for (const { at: rel, entry, ip } of extraHostEntries(value)) {
    const reason = extraHostReason(ip)
    if (reason) {
      out.add(
        'build_extra_host_internal',
        [...at, 'extra_hosts', ...rel],
        `build extra host \`${entry}\``,
        reason
      )
    }
  }
}

function checkBuild(
  out: Refusals,
  serviceSegments: string[],
  build: unknown,
  topLevelSecrets: Record<string, unknown>
): void {
  const at = [...serviceSegments, 'build']
  if (build === undefined || build === null) return
  if (typeof build === 'string') {
    checkContext(out, at, 'build context', build)
    return
  }
  if (!isRecord(build)) return
  if (build.context !== undefined) {
    checkContext(out, [...at, 'context'], 'build context', build.context)
  }
  if (build.dockerfile !== undefined) {
    out.path('build_context_outside_project', [...at, 'dockerfile'], 'Dockerfile', build.dockerfile)
  }
  checkAdditionalContexts(out, at, build.additional_contexts)
  checkPrivileges(out, at, build)
  checkSsh(out, at, build.ssh)
  checkSecrets(out, at, build.secrets, topLevelSecrets)
  checkExtraHosts(out, at, build.extra_hosts)
}

/**
 * Every build option a (merged or single-layer) Compose data tree sets that
 * no deploy may carry. Tag sentinels are resolved first, so a value hidden
 * inside an `!override` is judged like any other.
 */
export function collectBuildRefusals(data: unknown): BuildRefusal[] {
  const out = new Refusals()
  const root = resolveComposeTags(data)
  if (!isRecord(root) || !isRecord(root.services)) return out.found
  const topLevelSecrets = isRecord(root.secrets) ? root.secrets : {}
  for (const [name, body] of Object.entries(root.services)) {
    if (isRecord(body)) checkBuild(out, ['services', name], body.build, topLevelSecrets)
  }
  return out.found
}
