/**
 * Versions on the two wires (Road to 0.1.x, `wire-version`).
 *
 * Daemon ↔ control plane: the daemon reports its semver as
 * `daemonBuild.version` in the hello / heartbeat / ping (turbopaneld
 * src/app/version.ts). This module holds it against the floor the control plane
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
 * Dispatching a control-plane update does not consult
 * `MIN_SUPPORTED_DAEMON_VERSION`: the daemon only runs the reconcile. A
 * daemon self-update does not consult the daemon's instance floor either.
 * The downgrade guard lives on the daemon, which refuses to install a
 * control plane below its own `MIN_SUPPORTED_INSTANCE_VERSION`.
 *
 * The daemon holds this instance's version the other way
 * (`turbopaneld/src/instance/version-wire.ts`, `MIN_SUPPORTED_INSTANCE_VERSION`).
 * Bump that floor and `MIN_SUPPORTED_DAEMON_VERSION` together, with a reason
 * in both Versions-on-the-wires notes. Capability gates below are peer-version
 * feature flags, distinct from the metrics hardware-profile capability plan.
 *
 * `DAEMON_WIRE_FEATURES` is the advertised feature set: the peer says what it
 * supports, on `hello.features` and the attach `version` frame. That is
 * distinct from `DAEMON_FEATURE_MIN_VERSIONS`, which infers support from a
 * semver floor. A new wire message is gated on the advertisement. It does
 * not raise either floor.
 *
 * Workers and Deno both import this module — no Deno APIs.
 */

export const INSTANCE_VERSION_HEADER = "x-turbopanel-version";
export const INSTANCE_REVISION_HEADER = "x-turbopanel-revision";
export const CLIENT_VERSION_HEADER = "x-turbopanel-client-version";

/**
 * The oldest daemon this control plane will dispatch commands to. Bump when
 * a wire change stops being expand-only — never past what the current
 * release's installer ships.
 */
export const MIN_SUPPORTED_DAEMON_VERSION = "0.1.0";

const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function parseSemver(
  value: string | undefined | null,
): ParsedSemver | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const m = SEMVER_RE.exec(
    trimmed.startsWith("v") ? trimmed.slice(1) : trimmed,
  );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  // Numeric identifiers sort before alphanumeric ones (semver §11.4.3).
  if (na) return -1;
  if (nb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** semver precedence: negative when `a` < `b`, zero when equal, positive when `a` > `b`. */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A pre-release sorts before the release it precedes.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const n = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i += 1) {
    const c = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (c !== 0) return c;
  }
  return a.prerelease.length - b.prerelease.length;
}

export type DaemonSupportStatus = "supported" | "unsupported" | "unknown";

export type DaemonSupport = {
  status: DaemonSupportStatus;
  /** The version the daemon reported, verbatim; `null` when it sent none or something unparsable. */
  version: string | null;
  minVersion: string;
};

/**
 * Hold a daemon's reported version against `MIN_SUPPORTED_DAEMON_VERSION`.
 * No version, or one that is not a semver, is `unknown` — see the module
 * comment for why that is not `unsupported` yet.
 */
export function resolveDaemonSupport(
  reportedVersion: string | undefined | null,
  minVersion: string = MIN_SUPPORTED_DAEMON_VERSION,
): DaemonSupport {
  const parsed = parseSemver(reportedVersion);
  const floor = parseSemver(minVersion);
  if (!parsed || !floor) {
    return {
      status: "unknown",
      version: parsed ? reportedVersion!.trim() : null,
      minVersion,
    };
  }
  return {
    status: compareSemver(parsed, floor) < 0 ? "unsupported" : "supported",
    version: reportedVersion!.trim(),
    minVersion,
  };
}

/** The command consumer's refusal, and the servers page's explanation. */
export function daemonUnsupportedReason(support: DaemonSupport): string {
  return `Daemon version ${
    support.version ?? "unknown"
  } is below the supported minimum ${support.minVersion} — update the daemon`;
}

/**
 * Panel features that need a daemon at or above a semver (the daemon renders
 * the artifact). Twin of `DAEMON_FEATURE_MIN_VERSIONS` in
 * `turbopaneld/src/instance/version-wire.ts` — contract-drift keeps them equal.
 *
 * `instance-cert-sources-per-hostname` opens when the connected daemon is the
 * release that renders per-hostname certificate sources in
 * `orchestration/roles/caddy/templates/Caddyfile.j2` (the 0.1.1 daemon line).
 * A panel-visible admin feature gated on a daemon artifact adds its entry
 * here. The UI phase calls `resolveDaemonCapabilities` and does not
 * re-implement semver comparison. An unknown peer version is not supported.
 */
export const DAEMON_FEATURE_MIN_VERSIONS: Readonly<Record<string, string>> = {
  "instance-cert-sources-per-hostname": "0.1.1",
};

/**
 * Features this process advertises on the cell wire. Twin of
 * `DAEMON_WIRE_FEATURES` in `turbopaneld/src/instance/version-wire.ts` —
 * contract-drift keeps them equal.
 *
 * This list is what the peer says it supports. `DAEMON_FEATURE_MIN_VERSIONS`
 * is the semver-floor inference for daemon-rendered artifacts. Do not treat
 * them as the same gate.
 */
export const DAEMON_WIRE_FEATURES = [
  "managed-upgrade-v1",
  "update-progress-v1",
  "sealed-instance-secrets-v1",
] as const;

export type DaemonWireFeature = (typeof DAEMON_WIRE_FEATURES)[number];

/**
 * The daemon opens `tpdaemon` envelopes on `public-urls-update`
 * (`keyEnvelope`) and `tunnel-token` (`tokenEnvelope`). Without it the
 * control plane still sends the legacy plaintext fields.
 */
export const SEALED_INSTANCE_SECRETS_FEATURE: DaemonWireFeature =
  "sealed-instance-secrets-v1";

/** Features that need an instance at or above a semver. Empty until one lands. */
export const INSTANCE_FEATURE_MIN_VERSIONS: Readonly<Record<string, string>> =
  {};

function peerSupportsFeature(
  parsed: ParsedSemver | null,
  minVersion: string,
): boolean {
  if (!parsed) return false;
  const floor = parseSemver(minVersion);
  if (!floor) return false;
  return compareSemver(parsed, floor) >= 0;
}

function resolvePeerCapabilities(
  reportedVersion: string | undefined | null,
  floors: Readonly<Record<string, string>>,
): Record<string, boolean> {
  const parsed = parseSemver(reportedVersion);
  const out: Record<string, boolean> = {};
  for (const [feature, minVersion] of Object.entries(floors)) {
    out[feature] = peerSupportsFeature(parsed, minVersion);
  }
  return out;
}

/** Which daemon-rendered features a reported daemon version can serve. */
export function resolveDaemonCapabilities(
  reportedVersion: string | undefined | null,
  floors: Readonly<Record<string, string>> = DAEMON_FEATURE_MIN_VERSIONS,
): Record<string, boolean> {
  return resolvePeerCapabilities(reportedVersion, floors);
}

/** Which instance-side features a reported control-plane version can serve. */
export function resolveInstanceCapabilities(
  reportedVersion: string | undefined | null,
  floors: Readonly<Record<string, string>> = INSTANCE_FEATURE_MIN_VERSIONS,
): Record<string, boolean> {
  return resolvePeerCapabilities(reportedVersion, floors);
}
