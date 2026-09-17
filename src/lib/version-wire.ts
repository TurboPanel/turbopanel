/**
 * Versions on the two wires (Road to 0.1.x, `wire-version`).
 *
 * Daemon ↔ control plane: the daemon reports its semver as
 * `daemonBuild.version` in the hello / heartbeat / ping (turbopaneld
 * src/version.ts). This module holds it against the floor the control plane
 * supports. A daemon below the floor keeps its connection — the update path
 * *is* that connection — but the command consumer refuses to dispatch to it
 * and the servers page says why. A daemon that reports no version at all is
 * `unknown`: every build before 0.1.0 is one, so this stays a flag rather
 * than a refusal until the fleet is re-enrolled on tagged builds.
 *
 * App ↔ instance: the instance stamps `x-turbopanel-version` on every
 * response and `/api/health` carries `version`; a client that is not the
 * bundled web export sends `x-turbopanel-client-version`. The instance reads
 * the client's header and enforces nothing — expand first, contract in a
 * later release once a client exists that is older than the instance.
 *
 * Both halves are expand-only by convention: a field an older peer does not
 * send is `undefined`, never an error.
 *
 * Workers and Deno both import this module — no Deno APIs.
 */

export const INSTANCE_VERSION_HEADER = 'x-turbopanel-version'
export const CLIENT_VERSION_HEADER = 'x-turbopanel-client-version'

/**
 * The oldest daemon this control plane will dispatch commands to. Bump when
 * a wire change stops being expand-only — never past what the current
 * release's installer ships.
 */
export const MIN_SUPPORTED_DAEMON_VERSION = '0.1.0'

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export type ParsedSemver = {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export function parseSemver(value: string | undefined | null): ParsedSemver | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const m = SEMVER_RE.exec(trimmed.startsWith('v') ? trimmed.slice(1) : trimmed)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  }
}

function compareIdentifiers(a: string, b: string): number {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Number(a) - Number(b)
  // Numeric identifiers sort before alphanumeric ones (semver §11.4.3).
  if (na) return -1
  if (nb) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** semver precedence: negative when `a` < `b`, zero when equal, positive when `a` > `b`. */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  // A pre-release sorts before the release it precedes.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const n = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < n; i += 1) {
    const c = compareIdentifiers(a.prerelease[i], b.prerelease[i])
    if (c !== 0) return c
  }
  return a.prerelease.length - b.prerelease.length
}

export type DaemonSupportStatus = 'supported' | 'unsupported' | 'unknown'

export type DaemonSupport = {
  status: DaemonSupportStatus
  /** The version the daemon reported, verbatim; `null` when it sent none or something unparsable. */
  version: string | null
  minVersion: string
}

/**
 * Hold a daemon's reported version against `MIN_SUPPORTED_DAEMON_VERSION`.
 * No version, or one that is not a semver, is `unknown` — see the module
 * comment for why that is not `unsupported` yet.
 */
export function resolveDaemonSupport(
  reportedVersion: string | undefined | null,
  minVersion: string = MIN_SUPPORTED_DAEMON_VERSION,
): DaemonSupport {
  const parsed = parseSemver(reportedVersion)
  const floor = parseSemver(minVersion)
  if (!parsed || !floor) {
    return { status: 'unknown', version: parsed ? reportedVersion!.trim() : null, minVersion }
  }
  return {
    status: compareSemver(parsed, floor) < 0 ? 'unsupported' : 'supported',
    version: reportedVersion!.trim(),
    minVersion,
  }
}

/** The command consumer's refusal, and the servers page's explanation. */
export function daemonUnsupportedReason(support: DaemonSupport): string {
  return `Daemon version ${support.version ?? 'unknown'} is below the supported minimum ${support.minVersion} — update the daemon`
}
