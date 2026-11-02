import type { ServerReportedIp } from './server-addresses.ts'
import type {
  ServerDockerMetadata,
  ServerHardwareProfile,
  ServerHostResources,
  ServerOsMetadata,
  ServerReleaseLinkScanMetadata,
  ServerTimeSync,
} from '../features/servers/server-metadata.ts'
import type { MetricsCapabilityPlan } from './capability-plan.ts'
import type { ServiceRunState } from './service-run-state.ts'
import type { ManagedPermissionsObserved } from '../features/managed/privileges/observed.ts'
import type { FabricPeerHealth, FabricReconcileObservedPeer } from './commands/schemas.ts'
import { isValidWireguardEndpoint, isValidWireguardPublicKey } from '../features/fabric/wg.ts'
import { DAEMON_WIRE_FEATURES } from '../lib/version-wire.ts'

export type DaemonBuildInfo = {
  commit: string
  buildId: string
  builtAt?: string
  channel?: string
  /** The daemon's semver (turbopaneld src/app/version.ts); absent from builds before 0.1.0. */
  version?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function parseDaemonBuildInfo(value: unknown): DaemonBuildInfo | undefined {
  if (!isRecord(value)) return undefined
  if (!isString(value.commit) || value.commit.length === 0) return undefined
  if (!isString(value.buildId) || value.buildId.length === 0) return undefined
  const daemonBuild: DaemonBuildInfo = {
    commit: value.commit,
    buildId: value.buildId,
  }
  if (isString(value.builtAt)) daemonBuild.builtAt = value.builtAt
  if (isString(value.channel)) daemonBuild.channel = value.channel
  if (isString(value.version)) daemonBuild.version = value.version
  return daemonBuild
}

export type FabricPathPeerHealth = 'healthy' | 'stale' | 'never'

export type FabricPathWireCandidate = {
  publicKey: string
  endpoints: string[]
}

export type FabricPathWireObservation = {
  publicKey: string
  endpoint?: string
  lastHandshakeAt?: string
  health: FabricPathPeerHealth
  latencyMs?: number
}

/**
 * Hardware profile (sensor/NIC slots, topology device/filesystem ids,
 * hosting path, drivetemp opt-in, generation) pushed to the daemon. Full
 * replacement semantics: an absent field clears that setting on the daemon,
 * so the persisted `server.metadata.hardwareProfile` copy stays the source
 * of truth. Carries `generation` so the daemon can stamp subsequent samples
 * with `hardwareProfileGeneration`.
 */
export type TopologyOverridesUpdatePayload = ServerHardwareProfile

/**
 * Capability plan pushed to the daemon so it can truncate the metrics sample
 * before POST. Full replacement of the persisted plan+generation pair.
 */
export type CapabilityPlanUpdatePayload = MetricsCapabilityPlan

/**
 * Sent once on cell attach, the counterpart to the daemon's `hello`.
 * `instanceVersion` is `INSTANCE_VERSION`. Absent on control planes that
 * predate the field — the daemon treats that as `unknown`.
 */
export type CellAttachVersionMessage = {
  type: 'version'
  commit: string
  branch: string
  at: string
  instanceVersion?: string
  /**
   * Features this control plane advertises (`DAEMON_WIRE_FEATURES`).
   * Omitted by a peer that predates the field; the daemon treats that as
   * none (`instanceSupports` stays closed).
   */
  features?: string[]
  /**
   * Advised idle-ping cadence in seconds; daemons clamp it to [15, 120].
   * Pinned daemons take the interval from the signed hello instead.
   */
  heartbeatSeconds?: number
}

/** Control-plane → daemon self-update. Optional pin fields are expand-only. */
export type DaemonUpdateMessage = {
  type: 'update'
  id: string
  channel?: string
  updateUrl?: string
  updateSha256?: string
  /** Correlates progress frames for one upgrade. */
  upgradeId?: string
  /** Pinned manifest URL (`pinnedChannelManifestUrl`). */
  manifestUrl?: string
  /** Git commit the pin names, when the manifest carries one. */
  targetCommit?: string
  at: string
}

/** Control-plane → daemon control-plane update. Optional pin fields are expand-only. */
/** Daemon → instance: the outcome of an `instance-update`. Mirrors turbopaneld `cell-messages.ts`. */
export type InstanceUpdateResultMessage = {
  type: 'instance-update-result'
  id: string
  ok: boolean
  error?: string
  /** Why it failed or rolled back (a rollback reason, `preflight_in_progress`, …). */
  errorCode?: string
  upgradeId?: string
  at: string
}

export type InstanceUpdateMessage = {
  type: 'instance-update'
  id: string
  channel?: string
  manifestUrl?: string
  /** UI package pin. Passed to run.sh as `--ui-manifest-url`. */
  uiManifestUrl?: string
  /** Semver the control plane is about to install, when the manifest names one. */
  targetVersion?: string
  /** Correlates progress frames for one upgrade. */
  upgradeId?: string
  /** Git commit the pin names, when the manifest carries one. */
  targetCommit?: string
  at: string
}

export const UPDATE_PROGRESS_UNITS = ['daemon', 'instance'] as const
export type UpdateProgressUnit = 'daemon' | 'instance'

export const UPDATE_PROGRESS_STAGES = [
  'preparing',
  'downloading',
  'installing',
  'restarting',
  'verifying',
  'done',
  'failed',
  'rolled-back',
] as const
export type UpdateProgressStage =
  | 'preparing'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'rolled-back'

/**
 * Fire-and-forget upgrade progress. No correlated request: it must not
 * complete a pending `update` / `instance-update`.
 */
export type UpdateProgressMessage = {
  type: 'update-progress'
  id: string
  upgradeId?: string
  unit: UpdateProgressUnit
  stage: UpdateProgressStage
  at: string
  detail?: string
  errorCode?: string
  /**
   * How the daemon's own restart went, sent with a `failed` stage whose
   * `errorCode` is `restart_failed`. Optional: an older daemon never sends it.
   */
  restart?: UpdateRestartReport
}

/** Diagnostics for a daemon restart that was reported as failed. Twin of the daemon's `cell-messages.ts`. */
export type UpdateRestartReport = {
  /** `enable` or `restart`: the `systemctl` verb that failed. */
  command?: string
  exitCode?: number
  signal?: string
  stderr?: string
  /** Times the command ran (2 after the one retry). */
  attempts: number
  elapsedMs: number
}

/** Where one deploy step stands. Twin of the daemon's `cell-messages.ts`. */
export type CommandProgressStepState =
  | 'ready' // already on the server, nothing to do (shown ticked from the start)
  | 'pending' // planned, not started
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped' // never ran because an earlier step failed or the deploy was cancelled

export const COMMAND_PROGRESS_STEP_STATES = [
  'ready',
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
] as const

export type CommandProgressStep = {
  /** Stable id: a kind, optionally `:` and a target (`install-php:8.3`). */
  id: string
  /** Plain words, user facing, no vendor platform names. */
  label: string
  state: CommandProgressStepState
  startedAt?: string
  finishedAt?: string
  /** Live one-line detail for the running step (the install step the server is on). */
  detail?: string
}

/**
 * The step plan of one command and where it stands. Every message carries
 * the whole payload, so a lost one is harmless; the control plane stores the
 * latest copy on `command.progress`.
 */
export type CommandProgress = {
  version: 1
  /** In execution order, at most {@link MAX_DAEMON_WS_PROGRESS_STEPS}. */
  steps: CommandProgressStep[]
  /** Id of the running step, or null when none is running. */
  current: string | null
  updatedAt: string
  /**
   * When the server began actually running this command, or `null` while it
   * waits for the host (another build holds the single build slot). Absent
   * from a daemon that does not report it. The control plane starts the
   * command's run deadline from here, so waiting never counts against it.
   */
  runningSince?: string | null
}

/**
 * Fire-and-forget deploy progress. No correlated request: it must not
 * complete the pending `command-dispatch` it describes.
 */
export type CommandProgressMessage = {
  type: 'command-progress'
  id: string
  commandId: string
  at: string
  progress: CommandProgress
}

/**
 * JSON messages exchanged between the instance and daemon over /ws.
 *
 * Canonical for the shared protocol. The daemon exports its own extracted
 * union at `turbopaneld/src/contracts/cell-messages.ts` (hello/heartbeat live
 * here; daemon snapshot typing and `drivetemp` enable results may diverge).
 */
/**
 * One control-plane hostname on `public-urls-update`. Twin of
 * `turbopaneld/src/contracts/cell-messages.ts`. An uploaded key travels as
 * `keyEnvelope`, a `tpdaemon` envelope the recipient daemon opens through
 * `POST /api/daemon/v1/secrets/decrypt`, when the daemon advertises
 * `sealed-instance-secrets-v1`. `keyPem` (plaintext) is the legacy field for
 * daemons that do not; it is never a stored column.
 */
export type InstanceHostnameCertSource = 'lets-encrypt' | 'platform-ca' | 'uploaded'

export type InstanceHostnameWireEntry = {
  host: string
  source: InstanceHostnameCertSource
  certPem?: string
  keyPem?: string
  keyEnvelope?: string
  uploadedCertId?: string
  /**
   * Port visitors use for this hostname (1-65535). Sent only to a daemon that
   * advertises `instance-hostname-public-port-v1`.
   */
  publicPort?: number
}

/**
 * Instance → co-located daemon: start (or, with an empty `token`, stop) the
 * Cloudflare tunnel. A daemon that advertises `sealed-instance-secrets-v1`
 * receives a non-empty token only as `tokenEnvelope` (`tpdaemon`); `token`
 * is the legacy plaintext field. Twin of `turbopaneld/src/contracts/cell-messages.ts`.
 */
export type TunnelTokenMessage = {
  type: 'tunnel-token'
  id: string
  token?: string
  tokenEnvelope?: string
  at: string
}

/**
 * Daemon → control plane: one finished scheduled backup run, read from the
 * host's result spool. Correlated by `id`: the daemon deletes the spooled
 * result only when a {@link BackupRunReportResultMessage} with the same `id`
 * arrives, so a report lost in a disconnect is simply sent again, and
 * `runId` (unique per policy) makes the second copy a no-op. The artifact
 * fields are present when `status` is `succeeded`. Twin of
 * `turbopaneld/src/contracts/cell-messages.ts`; not yet accepted inbound
 * (Road row `r2-backup-status-report` wires it).
 */
export type BackupRunReportMessage = {
  type: 'backup-run-report'
  id: string
  policyId: string
  runId: string
  startedAt: string
  finishedAt: string
  status: 'succeeded' | 'failed'
  error?: string
  backupId?: string
  sizeBytes?: number
  checksum?: string
  path?: string
  /** The database a managed engine's run dumped; absent from an older daemon and for storage copies. */
  database?: string
  /** `bk_` ids this run's retention removed from the policy's directory. */
  pruned?: string[]
  /** When the policy's timer next fires, read from systemd after the run. */
  nextRunAt?: string
  at: string
}

/**
 * Control plane → daemon: the report with this `id` is stored (`ok: true`) or
 * refused for good (`ok: false`, e.g. the policy is gone or targets another
 * server) — either way the daemon drops the spooled result. No reply means a
 * transient failure, and the report is sent again. Twin of
 * `turbopaneld/src/contracts/cell-messages.ts`.
 */
export type BackupRunReportResultMessage = {
  type: 'backup-run-report-result'
  id: string
  ok: boolean
  error?: string
  at: string
}

/**
 * Daemon → control plane: how copying one finished backup to its S3-compatible
 * target ended (wire feature `backup-s3-copy-v1`; the daemon sends it only to
 * a control plane that lists the feature). Correlated by `id` like
 * {@link BackupRunReportMessage}: the daemon deletes its spooled report only
 * when a {@link BackupCopyReportResultMessage} with the same `id` arrives, and
 * a second copy of the same report changes nothing. Twin of
 * `turbopaneld/src/contracts/cell-messages.ts`.
 */
export type BackupCopyReportMessage = {
  type: 'backup-copy-report'
  id: string
  destinationId: string
  managedId: string
  backupId: string
  policyId?: string
  state: 'copied' | 'failed'
  /** A plain reason when `state` is `failed`. */
  error?: string
  /** Object key inside the bucket (the target's prefix included). */
  objectKey?: string
  sizeBytes?: number
  attempts: number
  finishedAt: string
  /** `bk_` ids the bucket retention removed after this copy. */
  pruned?: string[]
  at: string
}

/** Control plane → daemon: the copy report with this `id` is stored (`ok: true`) or refused for good. */
export type BackupCopyReportResultMessage = {
  type: 'backup-copy-report-result'
  id: string
  ok: boolean
  error?: string
  at: string
}

/** Instance-wide ACME knobs for hostnames whose source is `lets-encrypt`. */
export type InstanceAcmeWireSettings = {
  contactEmail: string
  tosAccepted: boolean
  directoryUrl: string
  useStaging: boolean
}

/**
 * One member's observed replication health, as carried on
 * `managed-health-result`. Twin of the daemon's `ManagedMemberObservedResult`.
 */
export type ManagedHealthObservedMember = {
  memberId: string
  role: string
  status: string
  replication?: {
    state: string
    lagBytes?: number
    lagSeconds?: number
    observedAt: string
    receivedLsn?: string
    replayLsn?: string
    receiveLagBytes?: number
    /** MySQL / MariaDB replica: GTID sets received / applied (opaque, bounded). */
    receivedGtid?: string
    executedGtid?: string
    /** MySQL / MariaDB replica: every received transaction is applied. Absent = unknown. */
    fullyApplied?: boolean
    lastStreaming?: {
      at: string
      ageMs: number
      lagBytes?: number
      lagSeconds?: number
      receiveLagBytes?: number
    }
    /** Postgres primary only: WAL held back by the replicas' replication slots. */
    slotRetention?: {
      state: 'ok' | 'lagging' | 'critical'
      slot?: string
      walStatus?: string
      retainedBytes?: number
      safeBytes?: number
      active?: boolean
    }
  }
}

/**
 * Ask a host for the current permissions of some logins on one managed
 * cluster it runs (feature `managed-permissions-read-v1`). Read only.
 * Twin of the daemon's `ManagedPermissionsRequestMessage`.
 */
export type ManagedPermissionsRequestMessage = {
  type: 'managed-permissions-request'
  id: string
  managedId: string
  engine: string
  /** Applied engine usernames (up to {@link MAX_DAEMON_WS_PERMISSIONS_LOGINS}). */
  logins: string[]
  /** Postgres: databases whose objects to read. Ignored for MySQL and MariaDB. */
  databases: string[]
  at: string
}

/**
 * The host's answer: what the engine reports, bounded to
 * {@link MAX_DAEMON_WS_PERMISSIONS_JSON_BYTES}. The control plane parses
 * `permissions` with `parseManagedPermissionsObserved`.
 * Twin of the daemon's `ManagedPermissionsResultMessage`.
 */
export type ManagedPermissionsResultMessage = {
  type: 'managed-permissions-result'
  id: string
  ok: boolean
  permissions?: ManagedPermissionsObserved
  error?: string
  at: string
}

/** One peer address a host is asked to try (feature `server-network-check-v1`). */
export type ServerNetworkCheckTarget = {
  peerServerId: string
  /** The peer's address on the network being checked (an IPv4 or IPv6 literal). */
  address: string
  /** A TCP port the peer already listens on, reached from the asked host. */
  port: number
}

/** What happened for one {@link ServerNetworkCheckTarget}. */
export type ServerNetworkCheckEntry = {
  peerServerId: string
  address: string
  reachable: boolean
  /** Time to open the connection, whole milliseconds. Only when reachable. */
  latencyMs?: number
  /** The local address the connection left from. Only when reachable. */
  sourceAddress?: string
  /** The local interface that owns `sourceAddress`, when known. */
  interface?: string
  /** A short reason when not reachable: `refused`, `timeout`, `unreachable`, `invalid_target`. */
  error?: string
}

/**
 * Ask a host to try a TCP connection to each target and say what happened
 * (feature `server-network-check-v1`). Nothing is sent on the connection and
 * nothing is stored. Twin of the daemon's `ServerNetworkCheckRequestMessage`.
 */
export type ServerNetworkCheckRequestMessage = {
  type: 'server-network-check-request'
  id: string
  /** Up to {@link MAX_DAEMON_WS_NETWORK_CHECK_TARGETS}. */
  targets: ServerNetworkCheckTarget[]
  at: string
}

/**
 * The host's answer, on the request's id. Always sent: a request that cannot
 * be run is `ok: false` with a short `error`; otherwise `results` holds one
 * entry per target, in order.
 * Twin of the daemon's `ServerNetworkCheckResultMessage`.
 */
export type ServerNetworkCheckResultMessage = {
  type: 'server-network-check-result'
  id: string
  ok: boolean
  results?: ServerNetworkCheckEntry[]
  error?: string
  at: string
}

/**
 * The commands a daemon is carrying, sent on `hello` and `heartbeat` (feature
 * `command-recovery-v1`) only while either list is not empty. `running` holds
 * the ids it has accepted and not finished (including commands waiting behind
 * another build); `unacked` holds the ids whose final `command-outcome` it keeps
 * until a {@link CommandOutcomeAckMessage} arrives. Twin of
 * `turbopaneld/src/contracts/cell-messages.ts`.
 */
export type CommandRecoveryReport = {
  running: string[]
  unacked: string[]
}

/** Control plane -> daemon: the final outcome of command `id` is stored; drop the held copy. */
export type CommandOutcomeAckMessage = {
  type: 'command-outcome-ack'
  id: string
  at: string
}

/** One replica in a `managed-health-report`: `down`, or its reading. */
export type ManagedHealthReportMember = {
  managedId: string
  memberId: string
  down?: true
  replication?: NonNullable<ManagedHealthObservedMember['replication']>
}

/**
 * Control plane → daemon (feature `acme-issue-v1`): place the certificate order
 * for `names` from this server's own addresses over the HTTP proof. The finished
 * pair is reported through `POST /api/daemon/v1/tls/issued` with `requestId`;
 * no message ever carries the pair. Twin of the daemon's `AcmeIssueRequestMessage`.
 */
export type AcmeIssueRequestMessage = {
  type: 'acme-issue-request'
  requestId: string
  tlsId: string
  names: string[]
  directory: 'production' | 'staging'
  contactEmail: string
  /** The request is open until this time (ISO 8601). */
  startByIso: string
  /** Other servers that pass the proof path on; the issuer checks each before asking the authority. */
  helpers: AcmeProofHelper[]
  at: string
}

export type AcmeProofHelper = { serverId: string; address: string }

/** Control plane → daemon: pass `/.well-known/acme-challenge/*` for `names` to `targetAddress` until `expiresAtIso`. */
export type AcmeProofForwardMessage = {
  type: 'acme-proof-forward'
  requestId: string
  names: string[]
  targetAddress: string
  expiresAtIso: string
  at: string
}

/** Control plane → daemon: stop passing the proof path on for this request. */
export type AcmeProofForwardEndMessage = {
  type: 'acme-proof-forward-end'
  requestId: string
  at: string
}

/**
 * Daemon → control plane: how the order is going. Never carries the certificate
 * or its key (the validator refuses those field names).
 */
export type AcmeIssueEventMessage = {
  type: 'acme-issue-event'
  requestId: string
  stage: 'started' | 'issued' | 'failed'
  /** A plain reason when `stage` is `failed`. */
  reason?: string
  /** Leaf expiry (ISO 8601) when `stage` is `issued`. */
  notAfterIso?: string
  at: string
}

/** Daemon → control plane: the proof path is passed on (`acme-proof-forward-ready`) or could not be (`-failed`). */
export type AcmeProofForwardReportMessage = {
  type: 'acme-proof-forward-ready' | 'acme-proof-forward-failed'
  requestId: string
  reason?: string
  at: string
}

export type DaemonMessage =
  | {
      type: 'hello'
      at: string
      daemonBuild: DaemonBuildInfo
      hostname?: string
      machineKey?: string
      /** Host OS from `/etc/os-release` (+ Deno build); persisted to `server.os_*` columns. */
      os?: ServerOsMetadata
      /**
       * Host capacity (cpu / RAM / swap totals) plus `ips` from `/proc` /
       * `Deno.networkInterfaces`; persisted to `server.metadata.resources`.
       */
      resources?: ServerHostResources
      /** Host timezone + NTP state; persisted to timezone / NTP columns. */
      timeSync?: ServerTimeSync
      /**
       * Docker CLI / Compose plugin versions; persisted to `server.metadata.docker`.
       * Omit when Docker is not installed.
       */
      docker?: ServerDockerMetadata
      /**
       * Per-service run state (running, restart count, last error); persisted to
       * `server.metadata.services`. Omitted when the daemon is not watching
       * Docker; `[]` means no services on the host.
       */
      services?: ServiceRunState[]
      /**
       * Advertised wire features (`DAEMON_WIRE_FEATURES`). Omitted by a daemon
       * that predates the field; persistence stores `[]`.
       */
      features?: string[]
      /**
       * Bounded summary of the daemon's boot-time check of live releases for
       * links that leave the release; persisted to
       * `server.metadata.releaseLinkScan`. Omitted until a scan has run, and by
       * a daemon that predates the field. Usually arrives on a heartbeat, since
       * the scan finishes after the first hello.
       */
      releaseLinkScan?: ServerReleaseLinkScanMetadata
      /** Commands in flight and results awaiting an ack (feature `command-recovery-v1`). */
      commands?: CommandRecoveryReport
    }
  | {
      type: 'heartbeat'
      at: string
      daemonBuild?: DaemonBuildInfo
      /** Change-detected time-sync facts; persisted to timezone / NTP columns. */
      timeSync?: ServerTimeSync
      /**
       * Change-detected host resources (typically `{ ips }`); persisted to
       * `server.metadata.resources`.
       */
      resources?: ServerHostResources
      /**
       * Change-detected Docker facts; persisted to `server.metadata.docker`.
       * Omit when Docker is not installed.
       */
      docker?: ServerDockerMetadata
      /** Change-detected link-check summary; persisted to `server.metadata.releaseLinkScan`. */
      releaseLinkScan?: ServerReleaseLinkScanMetadata
      /**
       * Change-detected per-service run state; persisted to
       * `server.metadata.services`. Omitted when the daemon is not watching
       * Docker; `[]` means no services on the host.
       */
      services?: ServiceRunState[]
      /** Commands in flight and results awaiting an ack (feature `command-recovery-v1`). */
      commands?: CommandRecoveryReport
    }
  | { type: 'echo'; payload: unknown; at: string }
  | CellAttachVersionMessage
  | { type: 'addresses-request'; id: string; at: string }
  | {
      type: 'addresses-result'
      id: string
      ips: ServerReportedIp[]
      at: string
    }
  | {
      type: 'managed-logs-request'
      id: string
      managedId: string
      tail: number
      at: string
    }
  | {
      type: 'managed-logs-result'
      id: string
      logs: string
      error?: string
      at: string
    }
  | {
      type: 'managed-health-request'
      id: string
      managedId: string
      memberId: string
      /** The member's real role — the daemon reads a `replica` as a standby. */
      role: 'primary' | 'replica'
      engine: string
      at: string
    }
  | {
      type: 'managed-health-result'
      id: string
      ok: boolean
      member?: ManagedHealthObservedMember
      error?: string
      at: string
    }
  | ManagedPermissionsRequestMessage
  | ManagedPermissionsResultMessage
  | ServerNetworkCheckRequestMessage
  | ServerNetworkCheckResultMessage
  | AcmeIssueRequestMessage
  | AcmeProofForwardMessage
  | AcmeProofForwardEndMessage
  | AcmeIssueEventMessage
  | AcmeProofForwardReportMessage
  | {
      /**
       * Daemon-initiated, fire-and-forget: every managed replica the host runs,
       * read just now (every 30 s; feature `managed-health-report-v1`). A
       * replica whose engine is down is `down: true` with no `replication`.
       * Twin of the daemon's `ManagedHealthReportMember`.
       */
      type: 'managed-health-report'
      members: ManagedHealthReportMember[]
      at: string
    }
  | {
      /**
       * Daemon-initiated, fire-and-forget: every `tp0` peer as read by the
       * daemon's 60 s refresh, sent when a peer's health class changed and at
       * most every 5 minutes otherwise (feature `fabric-peer-report-v1`).
       * `observedAt` is when the dump was read (daemon clock).
       */
      type: 'fabric-peers-report'
      peers: FabricReconcileObservedPeer[]
      observedAt: string
      at: string
    }
  | {
      /**
       * Daemon-initiated, fire-and-forget (feature `repo-key-report-v1`): the
       * package source named `keyName` publishes a signing key whose
       * fingerprint (`got`, hex) is not in the daemon's `expected` list. The
       * install went on (package signatures are still checked); the control
       * plane tells the organization's managers. The daemon sends it once per
       * key name and fingerprint.
       */
      type: 'repo-key-changed'
      keyName: string
      expected: string[]
      got: string
      at: string
    }
  | {
      type: 'container-logs-request'
      id: string
      containerId: string
      tail: number
      at: string
    }
  | {
      type: 'container-logs-result'
      id: string
      logs: string
      error?: string
      at: string
    }
  | {
      type: 'repo-read-request'
      id: string
      cloneUrl: string
      ref: string
      paths: string[]
      listPath?: string
      maxBytesPerFile: number
      credential?: string
      credentialKind?: string
      credentialUsername?: string
      at: string
    }
  | {
      type: 'repo-read-result'
      id: string
      ok: boolean
      commitSha?: string
      files?: {
        path: string
        found: boolean
        content?: string
        bytes?: number
        reason?: string
      }[]
      entries?: { path: string; kind: string; bytes?: number }[]
      error?: string
      at: string
    }
  | {
      type: 'repo-default-branch-request'
      id: string
      /** Anonymous only — the control plane never sends a credential here. */
      cloneUrl: string
      at: string
    }
  | {
      type: 'repo-default-branch-result'
      id: string
      ok: boolean
      /** `null` when the remote answered but named no branch (an empty repo). */
      defaultBranch?: string | null
      error?: string
      at: string
    }
  | {
      type: 'metrics-live-start'
      id: string
      leaseId: string
      intervalSeconds: number
      expiresAt: string
      at: string
    }
  | {
      type: 'metrics-live-start-result'
      id: string
      ok: boolean
      error?: string
      at: string
    }
  | { type: 'metrics-live-stop'; id: string; leaseId: string; at: string }
  | {
      type: 'metrics-live-stop-result'
      id: string
      ok: boolean
      error?: string
      at: string
    }
  | { type: 'metrics-capabilities-request'; id: string; at: string }
  | {
      type: 'metrics-capabilities-result'
      id: string
      ok: boolean
      capabilities?: Record<string, unknown>
      error?: string
      at: string
    }
  | {
      type: 'topology-overrides-update'
      id: string
      overrides: TopologyOverridesUpdatePayload
      at: string
    }
  | {
      type: 'topology-overrides-update-result'
      id: string
      ok: boolean
      error?: string
      at: string
    }
  | {
      type: 'capability-plan-update'
      id: string
      plan: CapabilityPlanUpdatePayload
      generation: number
      at: string
    }
  | {
      type: 'capability-plan-update-result'
      id: string
      ok: boolean
      error?: string
      at: string
    }
  | {
      type: 'capability-plan-clear'
      id: string
      at: string
    }
  | {
      type: 'capability-plan-clear-result'
      id: string
      ok: boolean
      error?: string
      at: string
    }
  | {
      type: 'deploy-cancel'
      id: string
      /** The `environment.deploy` command to stop. */
      commandId: string
      at: string
    }
  | {
      type: 'deploy-cancel-result'
      id: string
      ok: boolean
      outcome?: DeployCancelOutcome
      error?: string
      at: string
    }
  | {
      type: 'managed-ha-event'
      managedId: string
      sourceMemberId?: string
      /**
       * Who decided the primary is dead. Absent = the daemon's Orchestrator
       * poller. `postgres-probe` = the daemon's own Postgres probe on the
       * primary's host (feature `managed-ha-probe-v1`); see
       * `features/managed/ha-policy.ts` → `AUTOMATIC_FAILOVER_DETECTORS`.
       */
      detector?: string
      /**
       * Orchestrator's key for the dead instance (feature
       * `managed-ha-instance-v1`): the host and port it was discovered with.
       * The control plane fences only when they match the cluster's current
       * primary. Both or neither.
       */
      instanceHost?: string
      instancePort?: number
      /**
       * Bounded detector evidence. Logged and stored on the recovery row
       * (`metadata.detectorEvidence`). Only `spanMs` is read: it anchors the
       * fresh-standby gate's failure start (`ha-fresh-standby.ts`).
       */
      evidence?: Record<string, unknown>
      at: string
    }
  | {
      /**
       * Daemon-initiated, fire-and-forget (no correlated request/result, same
       * shape as `managed-ha-event`): the daemon's `topology/` module reporting
       * a new topology generation (stable device/filesystem/GPU/signal
       * identity). Server identity comes from the authenticated connection, not
       * a wire field — see `managed-ha-event`'s precedent.
       */
      type: 'topology-report'
      generation: number
      bootGeneration: number
      snapshot: unknown
      at: string
    }
  | {
      /**
       * Daemon-initiated, fire-and-forget (no correlated request/result, same
       * shape as `managed-ha-event`): `AcmeIssuanceObserver`'s live TLS-probe
       * verdict for one `tlsMode: 'acme'` hostname on this server, sent only on
       * a state change — a failure after a short debounce, or a recovery.
       * Merge-patched onto `tls.metadata.acme.lastError`; never writes
       * `tls.status`, so it cannot itself flip an `automatic` row's
       * deploy-readiness (see `handleAcmeIssuanceEvent`).
       */
      type: 'acme-issuance-event'
      hostname: string
      ok: boolean
      errorMessage?: string
      /**
       * Leaf expiry (ISO 8601) the daemon's probe read. Sent with `ok: true`
       * on the first good sighting, a recovery, and when a renewal changes it.
       * Merge-patched onto `tls.metadata.acme.notAfter`.
       */
      notAfter?: string
      at: string
    }
  | {
      /**
       * Daemon-initiated, fire-and-forget. Issuance state for the control
       * plane's own hostnames (`origin`), reported by
       * `InstanceAcmeRenewalScheduler` for each renewal attempt. Not
       * `acme-issuance-event`: that stream merge-patches an organization's
       * `tls` row, and the two must stay distinct so a consumer cannot
       * conflate them.
       */
      type: 'instance-acme-issuance-event'
      hostname: string
      ok: boolean
      errorMessage?: string
      /** Leaf notAfter from the installed certificate file. */
      notAfter?: string
      at: string
    }
  | {
      type: 'fabric-paths-request'
      id: string
      fabricId: string
      probeMs: number
      candidates: FabricPathWireCandidate[]
      at: string
    }
  | {
      type: 'fabric-paths-result'
      id: string
      paths: FabricPathWireObservation[]
      error?: string
      at: string
    }
  | {
      type: 'dev-sync-begin'
      id: string
      totalChunks: number
      totalBytes: number
      at: string
    }
  | {
      type: 'dev-sync-chunk'
      id: string
      index: number
      data: string
      at: string
    }
  | { type: 'dev-sync-end'; id: string; at: string }
  | {
      type: 'dev-sync-result'
      id: string
      ok: boolean
      error?: string
      at: string
    }
  | TunnelTokenMessage
  | {
      type: 'tunnel-token-result'
      id: string
      ok: boolean
      error?: string
      at: string
    }
  | BackupRunReportMessage
  | BackupRunReportResultMessage
  | CommandOutcomeAckMessage
  | BackupCopyReportMessage
  | BackupCopyReportResultMessage
  | {
      type: 'public-urls-update'
      id: string
      /** Flat compatibility list. Daemons below the per-hostname floor read only this. */
      urls: string[]
      /** Present when the daemon can render per-hostname certificate sources. */
      hostnames?: InstanceHostnameWireEntry[]
      /** Present when any hostname uses `lets-encrypt`. */
      instanceAcme?: InstanceAcmeWireSettings
      at: string
    }
  | {
      type: 'public-urls-update-result'
      id: string
      ok: boolean
      error?: string
      at: string
    }
  | DaemonUpdateMessage
  | {
      type: 'update-result'
      id: string
      ok: boolean
      error?: string
      errorCode?: string
      upgradeId?: string
      at: string
    }
  | InstanceUpdateMessage
  | UpdateProgressMessage
  | CommandProgressMessage
  | InstanceUpdateResultMessage
  | {
      type: 'command-dispatch'
      id: string
      commandId: string
      commandType: string
      payload: unknown
      at: string
    }
  | {
      type: 'command-ack'
      id: string
      at: string
      daemonReceivedAt: string
    }
  | {
      type: 'command-outcome'
      id: string
      ok: boolean
      result?: unknown
      error?: string
      at: string
      daemonReceivedAt?: string
      daemonRespondedAt?: string
    }

/** Read-time stale window when no inbound traffic is recorded on the cell. */
export const DAEMON_STALE_MS = 60_000
/** Background sweep threshold for marking connected cells offline (DO alarm + Redis maintain). */
export const DAEMON_OFFLINE_SWEEP_MS = 150_000
/** Redis cell registry maintenance interval (prune); not used for liveness. */
export const DAEMON_CELL_MAINTAIN_MS = 60_000
/** How long a terminal request's correlation record stays queryable after
 * finishing, across every request kind (deploys, backups, secret handoffs,
 * updates) on both the Redis and Durable Object backends — not update-specific
 * despite the value historically living under features/update. */
export const TERMINAL_REQUEST_RETENTION_MS = 120_000

/** Message types accepted from daemons after authentication succeeds. */
export const DAEMON_INBOUND_ALLOWED = new Set([
  'hello',
  'heartbeat',
  'addresses-result',
  'managed-logs-result',
  'managed-health-result',
  'managed-permissions-result',
  'server-network-check-result',
  'container-logs-result',
  'metrics-live-start-result',
  'metrics-live-stop-result',
  'metrics-capabilities-result',
  'topology-overrides-update-result',
  'capability-plan-update-result',
  'capability-plan-clear-result',
  'deploy-cancel-result',
  'repo-read-result',
  'repo-default-branch-result',
  'managed-ha-event',
  'managed-health-report',
  'fabric-peers-report',
  'repo-key-changed',
  'topology-report',
  'acme-issuance-event',
  'instance-acme-issuance-event',
  'acme-issue-event',
  'acme-proof-forward-ready',
  'acme-proof-forward-failed',
  'backup-run-report',
  'backup-copy-report',
  'fabric-paths-result',
  'dev-sync-result',
  'tunnel-token-result',
  'public-urls-update-result',
  'update-result',
  'instance-update-result',
  'update-progress',
  'command-progress',
  'command-ack',
  'command-outcome',
] as const)

/** Hard cap on a single inbound WebSocket text/binary frame (UTF-8 bytes). */
export const MAX_DAEMON_WS_FRAME_BYTES = 256 * 1024

/** Max characters for correlation / delivery identifiers (`id`, `requestId`). */
export const MAX_DAEMON_WS_ID_CHARS = 128

/**
 * How many advertised feature names a `hello` is scanned for. This is a parse
 * bound, not a limit on what a daemon may advertise: names this control plane
 * does not know are ignored, never a reason to close the socket (a newer daemon
 * must stay connected to an older control plane). Far above the daemon's
 * `DAEMON_WIRE_FEATURES`; a test in `protocol.test.ts` fails once that list
 * passes three quarters of it.
 */
export const MAX_DAEMON_WS_FEATURES = 4096

/** Max characters for one advertised feature name. */
export const MAX_DAEMON_WS_FEATURE_CHARS = 64

/** Max characters for `update-progress.errorCode`. */
export const MAX_DAEMON_WS_ERROR_CODE_CHARS = 64

/** Max ids in each list of a `commands` report on `hello` / `heartbeat`. */
export const MAX_DAEMON_WS_COMMAND_REPORT_IDS = 64

/** Max steps in one `command-progress.progress.steps`. */
export const MAX_DAEMON_WS_PROGRESS_STEPS = 24

/** Max characters for one `command-progress` step id. */
export const MAX_DAEMON_WS_PROGRESS_STEP_ID_CHARS = 64

/** Max characters for one `command-progress` step label. */
export const MAX_DAEMON_WS_PROGRESS_LABEL_CHARS = 60

/** Max characters for one `command-progress` step detail line. */
export const MAX_DAEMON_WS_PROGRESS_DETAIL_CHARS = 200

/** Max serialized size of one `command-progress.progress` payload. */
export const MAX_DAEMON_WS_PROGRESS_JSON_BYTES = 8 * 1024

/** Max characters for daemon-reported error strings. */
export const MAX_DAEMON_WS_ERROR_CHARS = 4 * 1024

/** Max characters for `managed-logs-result` / `container-logs-result.logs`. */
export const MAX_DAEMON_WS_LOGS_CHARS = 200 * 1024

/** Max characters for the string fields of `managed-health-result.member`. */
export const MAX_DAEMON_WS_MANAGED_HEALTH_FIELD_CHARS = 128
/** Bound for a replica's opaque GTID set text (`receivedGtid`, `executedGtid`). */
export const MAX_DAEMON_WS_MANAGED_GTID_CHARS = 4096

/** Max logins in one `managed-permissions-request`. */
export const MAX_DAEMON_WS_PERMISSIONS_LOGINS = 50
/** Max databases in one `managed-permissions-request`. */
export const MAX_DAEMON_WS_PERMISSIONS_DATABASES = 100
/** Max targets in one `server-network-check-request`. */
export const MAX_DAEMON_WS_NETWORK_CHECK_TARGETS = 32
/** Max UTF-8 bytes of `managed-permissions-result.permissions` JSON. */
export const MAX_DAEMON_WS_PERMISSIONS_JSON_BYTES = 128 * 1024

/** Max UTF-8 bytes of `metrics-capabilities-result.capabilities` JSON. */
export const MAX_DAEMON_WS_CAPABILITIES_BYTES = 96 * 1024

/**
 * Max UTF-8 bytes across every file in one `repo-read-result`.
 *
 * Comfortably under {@link MAX_DAEMON_WS_FRAME_BYTES} so a legitimate read
 * cannot be mistaken for a framing violation, and small enough that a
 * misbehaving daemon cannot push a repository through this channel.
 */
export const MAX_DAEMON_WS_REPO_READ_BYTES = 128 * 1024

/** Max directory entries in one `repo-read-result`. */
export const MAX_DAEMON_WS_REPO_READ_ENTRIES = 256

/** Max characters for `repo-default-branch-result.defaultBranch`. */
export const MAX_DAEMON_WS_DEFAULT_BRANCH_CHARS = 255

/** Max paths one `repo-read-request` may ask for. */
export const MAX_DAEMON_WS_REPO_READ_PATHS = 16

/** Max `fabric-paths-request.candidates` / `fabric-paths-result.paths` entries. */
export const MAX_DAEMON_WS_FABRIC_PATH_ENTRIES = 256

/** Max candidate endpoints per `fabric-paths-request` entry. */
export const MAX_DAEMON_WS_FABRIC_PATH_CANDIDATES = 8

const FABRIC_PEER_HEALTH = new Set(['healthy', 'stale', 'never'])

/** Max UTF-8 bytes for JSON-serialized `command-outcome.result`. */
export const MAX_DAEMON_WS_RESULT_JSON_BYTES = 64 * 1024

/** Max UTF-8 bytes for JSON-serialized `topology-report.snapshot`. */
export const MAX_DAEMON_WS_TOPOLOGY_REPORT_JSON_BYTES = 64 * 1024

/** Max characters for optional hostname / machineKey fields on hello. */
export const MAX_DAEMON_WS_HOST_FIELD_CHARS = 255

/** WebSocket close code for policy / size violations (RFC 6455). */
export const DAEMON_WS_POLICY_VIOLATION_CLOSE = 1008

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    ISO_TIMESTAMP_RE.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DAEMON_WS_ID_CHARS
}

function validateOptionalError(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string') return 'error must be a string'
  if (value.length > MAX_DAEMON_WS_ERROR_CHARS) {
    return 'error exceeds max length'
  }
  return null
}

function validateBoundedJson(value: unknown, maxBytes: number, label: string): string | null {
  if (value === undefined) return null
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return `${label} is not JSON-serializable`
    if (utf8ByteLength(encoded) > maxBytes) {
      return `${label} exceeds max size`
    }
  } catch {
    return `${label} is not JSON-serializable`
  }
  return null
}

function validateCommandResult(value: unknown): string | null {
  return validateBoundedJson(value, MAX_DAEMON_WS_RESULT_JSON_BYTES, 'result')
}

function validateTopologyReportSnapshot(value: unknown): string | null {
  return validateBoundedJson(value, MAX_DAEMON_WS_TOPOLOGY_REPORT_JSON_BYTES, 'snapshot')
}

function validatePresenceFields(record: Record<string, unknown>): string | null {
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (
    record.hostname !== undefined &&
    (typeof record.hostname !== 'string' || record.hostname.length > MAX_DAEMON_WS_HOST_FIELD_CHARS)
  ) {
    return 'invalid hostname'
  }
  if (
    record.machineKey !== undefined &&
    (typeof record.machineKey !== 'string' ||
      record.machineKey.length > MAX_DAEMON_WS_HOST_FIELD_CHARS)
  ) {
    return 'invalid machineKey'
  }
  if (record.daemonBuild !== undefined && !parseDaemonBuildInfo(record.daemonBuild)) {
    return 'invalid daemonBuild'
  }
  return validateCommandsReport(record.commands)
}

function isBoundedIdList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_DAEMON_WS_COMMAND_REPORT_IDS &&
    value.every(isBoundedId)
  )
}

function validateCommandsReport(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid commands'
  const report = value as Record<string, unknown>
  return isBoundedIdList(report.running) && isBoundedIdList(report.unacked)
    ? null
    : 'invalid commands'
}

function validateResultEnvelopeFields(record: Record<string, unknown>): string | null {
  if (!isBoundedId(record.id)) return 'invalid id'
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  const errorIssue = validateOptionalError(record.error)
  if (errorIssue) return errorIssue
  return null
}

function validateOptionalIsoTimestamp(value: unknown, field: string): string | null {
  if (value === undefined) return null
  if (!isIsoTimestamp(value)) return `invalid ${field}`
  return null
}

/**
 * A `hello` only has to carry an array (or nothing). Which names it holds is
 * not a reason to refuse it: {@link filterHelloFeatures} keeps the names this
 * control plane knows and ignores the rest.
 */
function validateHelloFeatures(value: unknown): string | null {
  if (value === undefined) return null
  return Array.isArray(value) ? null : 'invalid features'
}

const KNOWN_DAEMON_FEATURES: ReadonlySet<string> = new Set<string>(DAEMON_WIRE_FEATURES)

/** Result of {@link filterHelloFeatures}: the names kept and a bounded note about the rest. */
export type FilteredHelloFeatures = { features: string[]; note: string | null }

type FeatureVerdict = 'keep' | 'unknown' | 'malformed' | 'duplicate'

function featureVerdict(
  entry: unknown,
  known: ReadonlySet<string>,
  seen: Set<string>
): FeatureVerdict {
  if (
    typeof entry !== 'string' ||
    entry.length === 0 ||
    entry.length > MAX_DAEMON_WS_FEATURE_CHARS
  ) {
    return 'malformed'
  }
  if (!known.has(entry)) return 'unknown'
  if (seen.has(entry)) return 'duplicate'
  seen.add(entry)
  return 'keep'
}

/** A short, printable stand-in for an ignored entry, safe to put in a log line. */
function featureSample(entry: unknown): string {
  if (typeof entry !== 'string') return typeof entry
  return entry.slice(0, 24).replace(/[^ -~]/g, '?')
}

/**
 * Keep only the advertised feature names this control plane knows (its own
 * `DAEMON_WIRE_FEATURES`), in the daemon's order and without duplicates. Names
 * it does not know are ignored: it never gates on them, and a newer daemon
 * must not be refused for advertising more than an older control plane
 * expects. Malformed entries are dropped the same way. The stored list can
 * therefore never exceed the control plane's own list, and a capable daemon
 * never looks incapable, because every name the control plane gates on is
 * kept. At most {@link MAX_DAEMON_WS_FEATURES} entries are scanned.
 *
 * `note` is one bounded line (counts, and at most three short samples) when
 * anything was ignored, else `null`.
 */
export function filterHelloFeatures(
  entries: readonly unknown[],
  known: ReadonlySet<string> = KNOWN_DAEMON_FEATURES
): FilteredHelloFeatures {
  const features: string[] = []
  const seen = new Set<string>()
  const counts = { unknown: 0, malformed: 0, duplicate: 0 }
  const samples: string[] = []
  const scanned = Math.min(entries.length, MAX_DAEMON_WS_FEATURES)
  for (let index = 0; index < scanned; index++) {
    const entry = entries[index]
    const verdict = featureVerdict(entry, known, seen)
    if (verdict === 'keep') {
      features.push(entry as string)
      continue
    }
    counts[verdict] += 1
    if (samples.length < 3) samples.push(featureSample(entry))
  }
  const unscanned = entries.length - scanned
  const ignored = counts.unknown + counts.malformed + counts.duplicate + unscanned
  if (ignored === 0) return { features, note: null }
  const detail =
    `unknown=${counts.unknown} malformed=${counts.malformed} ` +
    `duplicate=${counts.duplicate} unscanned=${unscanned}`
  return {
    features,
    note:
      `hello features: received=${entries.length} kept=${features.length} ` +
      `ignored=${ignored} (${detail}) sample=[${samples.join(', ')}]`,
  }
}

function validateHelloFields(record: Record<string, unknown>): string | null {
  if (!parseDaemonBuildInfo(record.daemonBuild)) return 'invalid daemonBuild'
  const presence = validatePresenceFields(record)
  if (presence) return presence
  return validateHelloFeatures(record.features)
}

/**
 * Prefix of a validation reason that means "a well-formed field holds a value
 * this control plane does not know" (a newer daemon's enum value). The frame is
 * ignored, the socket stays up. Every other reason is a rejection.
 */
const UNKNOWN_VALUE_PREFIX = 'unknown value: '

function unknownValue(field: string): string {
  return `${UNKNOWN_VALUE_PREFIX}${field}`
}

const UPDATE_PROGRESS_UNIT_SET = new Set<string>(UPDATE_PROGRESS_UNITS)
const UPDATE_PROGRESS_STAGE_SET = new Set<string>(UPDATE_PROGRESS_STAGES)

function validateOptionalBoundedString(
  value: unknown,
  field: string,
  maxChars: number
): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string') return `${field} must be a string`
  if (value.length > maxChars) return `${field} exceeds max length`
  return null
}

function validateUpdateProgressFields(record: Record<string, unknown>): string | null {
  if (!isBoundedId(record.id)) return 'invalid id'
  if (record.upgradeId !== undefined && !isBoundedId(record.upgradeId)) {
    return 'invalid upgradeId'
  }
  if (typeof record.unit !== 'string') return 'invalid unit'
  if (!UPDATE_PROGRESS_UNIT_SET.has(record.unit)) return unknownValue('unit')
  if (typeof record.stage !== 'string') return 'invalid stage'
  if (!UPDATE_PROGRESS_STAGE_SET.has(record.stage)) return unknownValue('stage')
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  return (
    validateOptionalBoundedString(record.detail, 'detail', MAX_DAEMON_WS_ERROR_CHARS) ??
    validateOptionalBoundedString(record.errorCode, 'errorCode', MAX_DAEMON_WS_ERROR_CODE_CHARS)
  )
}

/**
 * Envelope of a `command-progress` frame. The `progress` payload itself is
 * checked by {@link validateCommandProgress} at the handler: a daemon one
 * release ahead may send a step shape this build does not know, and that
 * must drop the payload, not the socket.
 */
function validateCommandProgressFields(record: Record<string, unknown>): string | null {
  if (!isBoundedId(record.id)) return 'invalid id'
  if (!isBoundedId(record.commandId)) return 'invalid commandId'
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  return null
}

const COMMAND_PROGRESS_STEP_STATE_SET = new Set<string>(COMMAND_PROGRESS_STEP_STATES)

function validateBoundedString(value: unknown, field: string, maxChars: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return `invalid ${field}`
  if (value.length > maxChars) return `${field} exceeds max length`
  return null
}

function validateCommandProgressStep(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `invalid step ${index}`
  if (typeof value.state !== 'string') return `invalid step ${index} state`
  if (!COMMAND_PROGRESS_STEP_STATE_SET.has(value.state)) {
    return unknownValue(`step ${index} state`)
  }
  return (
    validateBoundedString(value.id, `step ${index} id`, MAX_DAEMON_WS_PROGRESS_STEP_ID_CHARS) ??
    validateBoundedString(value.label, `step ${index} label`, MAX_DAEMON_WS_PROGRESS_LABEL_CHARS) ??
    validateOptionalBoundedString(
      value.detail,
      `step ${index} detail`,
      MAX_DAEMON_WS_PROGRESS_DETAIL_CHARS
    ) ??
    validateOptionalIsoTimestamp(value.startedAt, `step ${index} startedAt`) ??
    validateOptionalIsoTimestamp(value.finishedAt, `step ${index} finishedAt`)
  )
}

/**
 * Shape and size of one {@link CommandProgress} payload. `null` when it is
 * acceptable, otherwise the reason. Steps are capped at
 * {@link MAX_DAEMON_WS_PROGRESS_STEPS}, every string at its own cap, and the
 * whole payload at {@link MAX_DAEMON_WS_PROGRESS_JSON_BYTES}.
 */
export function validateCommandProgress(value: unknown): string | null {
  if (!isRecord(value)) return 'invalid progress'
  if (value.version !== 1) return 'invalid progress version'
  if (!isIsoTimestamp(value.updatedAt)) return 'invalid progress updatedAt'
  if (value.current !== null && !isBoundedId(value.current)) return 'invalid progress current'
  if (value.runningSince !== null) {
    const issue = validateOptionalIsoTimestamp(value.runningSince, 'progress runningSince')
    if (issue) return issue
  }
  if (!Array.isArray(value.steps)) return 'invalid progress steps'
  if (value.steps.length > MAX_DAEMON_WS_PROGRESS_STEPS) return 'progress steps exceed max entries'
  return (
    validateCommandProgressSteps(value.steps, value.current) ??
    validateBoundedJson(value, MAX_DAEMON_WS_PROGRESS_JSON_BYTES, 'progress')
  )
}

/**
 * The plan as a whole: every step well formed, ids unique, at most one step
 * running, and `current` naming exactly that step (or null when none runs).
 */
function validateCommandProgressSteps(steps: unknown[], current: unknown): string | null {
  const ids = new Set<string>()
  let running: string | null = null
  for (const [index, step] of steps.entries()) {
    const issue = validateCommandProgressStep(step, index)
    if (issue) return issue
    const { id, state } = step as CommandProgressStep
    if (ids.has(id)) return `duplicate step id ${id}`
    ids.add(id)
    if (state !== 'running') continue
    if (running !== null) return 'more than one running step'
    running = id
  }
  return current === running ? null : 'progress current does not match the running step'
}

/** {@link validateCommandProgress} as a type guard. */
export function isCommandProgress(value: unknown): value is CommandProgress {
  return validateCommandProgress(value) === null
}

function validateAddressesResultFields(record: Record<string, unknown>): string | null {
  const base = validateResultEnvelopeFields(record)
  if (base) return base
  if (!Array.isArray(record.ips)) return 'invalid ips'
  return null
}

function validateManagedLogsResultFields(record: Record<string, unknown>): string | null {
  const base = validateResultEnvelopeFields(record)
  if (base) return base
  if (typeof record.logs !== 'string') return 'invalid logs'
  if (record.logs.length > MAX_DAEMON_WS_LOGS_CHARS) {
    return 'logs exceed max length'
  }
  return null
}

/**
 * The `files[]` array: per-entry shape and the cumulative content budget.
 *
 * The byte total is checked here as well as in the envelope validator: this
 * runs on the raw frame, before anything is handed onward.
 */
function validateRepoReadFiles(value: unknown): string | null {
  if (!Array.isArray(value)) return 'invalid files'
  if (value.length > MAX_DAEMON_WS_REPO_READ_PATHS) {
    return 'files exceed max entries'
  }
  let bytes = 0
  for (const file of value) {
    if (typeof file !== 'object' || file === null) return 'invalid file entry'
    const entry = file as Record<string, unknown>
    if (typeof entry.path !== 'string') return 'invalid file path'
    if (typeof entry.found !== 'boolean') return 'invalid file found'
    if (entry.content === undefined) continue
    if (typeof entry.content !== 'string') return 'invalid file content'
    bytes += utf8ByteLength(entry.content)
    if (bytes > MAX_DAEMON_WS_REPO_READ_BYTES) {
      return 'repo read exceeds max bytes'
    }
  }
  return null
}

/** The `entries[]` array — a listing, so only its size is bounded here. */
function validateRepoReadEntries(value: unknown): string | null {
  if (!Array.isArray(value)) return 'invalid entries'
  if (value.length > MAX_DAEMON_WS_REPO_READ_ENTRIES) {
    return 'entries exceed max'
  }
  return null
}

function validateRepoReadResultFields(record: Record<string, unknown>): string | null {
  const base = validateResultEnvelopeFields(record)
  if (base) return base
  if (typeof record.ok !== 'boolean') return 'invalid ok'
  if (record.files !== undefined) {
    const issue = validateRepoReadFiles(record.files)
    if (issue) return issue
  }
  if (record.entries !== undefined) {
    const issue = validateRepoReadEntries(record.entries)
    if (issue) return issue
  }
  return null
}

function validateRepoDefaultBranchResultFields(record: Record<string, unknown>): string | null {
  const base = validateResultEnvelopeFields(record)
  if (base) return base
  if (typeof record.ok !== 'boolean') return 'invalid ok'
  if (record.defaultBranch === undefined || record.defaultBranch === null) {
    return null
  }
  if (typeof record.defaultBranch !== 'string') return 'invalid defaultBranch'
  if (record.defaultBranch.length > MAX_DAEMON_WS_DEFAULT_BRANCH_CHARS) {
    return 'defaultBranch exceeds max length'
  }
  return null
}

const MANAGED_HA_EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateManagedHaEventFields(record: Record<string, unknown>): string | null {
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (typeof record.managedId !== 'string' || !MANAGED_HA_EVENT_ID_RE.test(record.managedId)) {
    return 'invalid managedId'
  }
  if (
    record.sourceMemberId !== undefined &&
    (typeof record.sourceMemberId !== 'string' ||
      !MANAGED_HA_EVENT_ID_RE.test(record.sourceMemberId))
  ) {
    return 'invalid sourceMemberId'
  }
  if (record.detector !== undefined && !isManagedHaDetectorName(record.detector)) {
    return 'invalid detector'
  }
  if (record.evidence !== undefined && !isRecord(record.evidence)) {
    return 'invalid evidence'
  }
  return validateManagedHaInstanceFields(record)
}

const MANAGED_HA_INSTANCE_HOST_MAX = 255

function validateManagedHaInstanceFields(record: Record<string, unknown>): string | null {
  const { instanceHost, instancePort } = record
  if (instanceHost === undefined && instancePort === undefined) return null
  if (
    typeof instanceHost !== 'string' ||
    instanceHost.length === 0 ||
    instanceHost.length > MANAGED_HA_INSTANCE_HOST_MAX
  ) {
    return 'invalid instanceHost'
  }
  if (
    typeof instancePort !== 'number' ||
    !Number.isInteger(instancePort) ||
    instancePort < 1 ||
    instancePort > 65535
  ) {
    return 'invalid instancePort'
  }
  return null
}

const MANAGED_HA_DETECTOR_RE = /^[a-z][a-z0-9-]{0,63}$/

/** Shape only: which detectors may start a failover is policy, not wire. */
function isManagedHaDetectorName(value: unknown): value is string {
  return typeof value === 'string' && MANAGED_HA_DETECTOR_RE.test(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Largest generation number the control plane stores (a Postgres `integer`). */
const MAX_TOPOLOGY_REPORT_GENERATION = 2_147_483_647

function isTopologyGenerationNumber(value: unknown): value is number {
  return isNonNegativeInt(value) && value <= MAX_TOPOLOGY_REPORT_GENERATION
}

function validateTopologyReportFields(record: Record<string, unknown>): string | null {
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (!isTopologyGenerationNumber(record.generation)) return 'invalid generation'
  if (!isTopologyGenerationNumber(record.bootGeneration)) {
    return 'invalid bootGeneration'
  }
  return validateTopologyReportSnapshot(record.snapshot)
}

function validateAcmeIssuanceEventFields(record: Record<string, unknown>): string | null {
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (
    typeof record.hostname !== 'string' ||
    record.hostname.length === 0 ||
    record.hostname.length > MAX_DAEMON_WS_HOST_FIELD_CHARS
  ) {
    return 'invalid hostname'
  }
  if (typeof record.ok !== 'boolean') return 'invalid ok'
  if (record.notAfter !== undefined && !isIsoTimestamp(record.notAfter)) {
    return 'invalid notAfter'
  }
  return validateOptionalError(record.errorMessage)
}

/** Most names one certificate order carries (matches the authority's own cap of 100; we send far fewer). */
export const MAX_ACME_ISSUE_NAMES = 100
/** Most helper servers one order lists. */
export const MAX_ACME_ISSUE_HELPERS = 64

/** A plain lower-case DNS name: no wildcard, no upper case, no trailing dot. */
const ACME_NAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
/** One IPv4 address in dotted form, each part 0 to 255 with no leading zeros. */
const ACME_IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const ACME_IPV6_GROUP_RE = /^[0-9a-f]{1,4}$/

/** A lower-case IPv6 literal: at most one `::`, groups of 1 to 4 hex digits, and an optional IPv4 tail. */
function isAcmeIpv6(value: string): boolean {
  if (value.length > 45 || !value.includes(':') || value.includes(':::')) return false
  const parts = value.split('::')
  if (parts.length > 2) return false
  const groups = parts.flatMap((part) => (part === '' ? [] : part.split(':')))
  const last = groups.at(-1)
  const tail = last?.includes('.') === true
  if (tail && !ACME_IPV4_RE.test(last)) return false
  const hex = tail ? groups.slice(0, -1) : groups
  if (!hex.every((g) => ACME_IPV6_GROUP_RE.test(g))) return false
  const width = hex.length + (tail ? 2 : 0)
  return parts.length === 2 ? width < 8 : width === 8
}

function isAcmeAddress(value: string): boolean {
  return ACME_IPV4_RE.test(value) || isAcmeIpv6(value)
}
const ACME_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Field names that would carry certificate material; refused on every acme-issue message. */
const ACME_FORBIDDEN_KEYS = [
  'certificatePem',
  'privateKeyPem',
  'privateKey',
  'certificate',
  'key',
  'pem',
]

function validateAcmeRequestId(value: unknown): string | null {
  return typeof value === 'string' && ACME_REQUEST_ID_RE.test(value) ? null : 'invalid requestId'
}

function validateAcmeNames(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACME_ISSUE_NAMES) {
    return 'invalid names'
  }
  const ok = value.every((n) => typeof n === 'string' && n.length <= 253 && ACME_NAME_RE.test(n))
  return ok ? null : 'invalid names'
}

function validateAcmeAddress(value: unknown): boolean {
  return typeof value === 'string' && isAcmeAddress(value)
}

function validateAcmeHelpers(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > MAX_ACME_ISSUE_HELPERS) return 'invalid helpers'
  for (const item of value) {
    const helper = item as { serverId?: unknown; address?: unknown } | null
    if (typeof helper !== 'object' || helper === null || !isBoundedId(helper.serverId)) {
      return 'invalid helpers'
    }
    if (!validateAcmeAddress(helper.address)) return 'invalid helpers'
    if (acmeForbiddenKey(helper as Record<string, unknown>) !== null) return 'invalid helpers'
  }
  return null
}

/** Unknown optional fields are ignored (expand-only), but never one that could carry the pair. */
function acmeForbiddenKey(record: Record<string, unknown>): string | null {
  return ACME_FORBIDDEN_KEYS.some((k) => k in record) ? 'must not carry certificate material' : null
}

function firstProblem(...problems: Array<string | null>): string | null {
  return problems.find((p) => p !== null) ?? null
}

/** Shape check for `acme-issue-request` (control plane to daemon; the sender and the daemon both use it). */
export function validateAcmeIssueRequestFields(record: Record<string, unknown>): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    isBoundedId(record.tlsId) ? null : 'invalid tlsId',
    validateAcmeNames(record.names),
    record.directory === 'production' || record.directory === 'staging'
      ? null
      : 'invalid directory',
    typeof record.contactEmail === 'string' &&
      record.contactEmail.length > 0 &&
      record.contactEmail.length <= 254
      ? null
      : 'invalid contactEmail',
    isIsoTimestamp(record.startByIso) ? null : 'invalid startByIso',
    validateAcmeHelpers(record.helpers),
    isIsoTimestamp(record.at) ? null : 'invalid at timestamp',
    acmeForbiddenKey(record)
  )
}

/** Shape check for `acme-proof-forward`. */
export function validateAcmeProofForwardFields(record: Record<string, unknown>): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    validateAcmeNames(record.names),
    validateAcmeAddress(record.targetAddress) ? null : 'invalid targetAddress',
    isIsoTimestamp(record.expiresAtIso) ? null : 'invalid expiresAtIso',
    isIsoTimestamp(record.at) ? null : 'invalid at timestamp',
    acmeForbiddenKey(record)
  )
}

/** Shape check for `acme-proof-forward-end`. */
export function validateAcmeProofForwardEndFields(record: Record<string, unknown>): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    isIsoTimestamp(record.at) ? null : 'invalid at timestamp',
    acmeForbiddenKey(record)
  )
}

/** Shape check for `acme-issue-event` (daemon to control plane). Never accepts a pair. */
export function validateAcmeIssueEventFields(record: Record<string, unknown>): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    record.stage === 'started' || record.stage === 'issued' || record.stage === 'failed'
      ? null
      : 'invalid stage',
    record.notAfterIso === undefined || isIsoTimestamp(record.notAfterIso)
      ? null
      : 'invalid notAfterIso',
    validateOptionalError(record.reason),
    isIsoTimestamp(record.at) ? null : 'invalid at timestamp',
    acmeForbiddenKey(record)
  )
}

/** Shape check for `acme-proof-forward-ready` and `acme-proof-forward-failed`. */
export function validateAcmeProofForwardReportFields(
  record: Record<string, unknown>
): string | null {
  return firstProblem(
    validateAcmeRequestId(record.requestId),
    validateOptionalError(record.reason),
    isIsoTimestamp(record.at) ? null : 'invalid at timestamp',
    acmeForbiddenKey(record)
  )
}

/** A backup policy id: lower-case, because the host also uses it as a systemd unit name. */
const BACKUP_POLICY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Daemon-minted run and artifact ids (`run_<hex>`, `bk_<hex>`); both become filenames. */
const BACKUP_RUN_TOKEN_RE = /^[\w-]{1,64}$/
const BACKUP_CHECKSUM_RE = /^[a-f0-9]{64}$/
const BACKUP_RUN_STATUSES = new Set(['succeeded', 'failed'])

/** Max characters for `backup-run-report.path`. */
export const MAX_DAEMON_WS_BACKUP_PATH_CHARS = 1024

/** Max characters for `backup-run-report.database`. */
export const MAX_DAEMON_WS_BACKUP_DATABASE_CHARS = 128

/** Max `backup-run-report.pruned` entries (a policy keeps at most 100 artifacts). */
export const MAX_DAEMON_WS_BACKUP_PRUNED = 256

function isBackupRunToken(value: unknown): value is string {
  return typeof value === 'string' && BACKUP_RUN_TOKEN_RE.test(value)
}

function isBackupPrunedList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_DAEMON_WS_BACKUP_PRUNED &&
    value.every((entry) => isBackupRunToken(entry))
  )
}

function validateBackupRunReportRun(record: Record<string, unknown>): string | null {
  if (!isBoundedId(record.id)) return 'invalid id'
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (typeof record.policyId !== 'string' || !BACKUP_POLICY_ID_RE.test(record.policyId)) {
    return 'invalid policyId'
  }
  if (!isBackupRunToken(record.runId)) return 'invalid runId'
  if (!isIsoTimestamp(record.startedAt)) return 'invalid startedAt'
  if (!isIsoTimestamp(record.finishedAt)) return 'invalid finishedAt'
  if (typeof record.status !== 'string') return 'invalid status'
  if (!BACKUP_RUN_STATUSES.has(record.status)) return unknownValue('status')
  return (
    validateOptionalIsoTimestamp(record.nextRunAt, 'nextRunAt') ??
    validateOptionalError(record.error)
  )
}

function validateBackupRunReportArtifact(record: Record<string, unknown>): string | null {
  if (record.backupId !== undefined && !isBackupRunToken(record.backupId)) {
    return 'invalid backupId'
  }
  if (
    record.sizeBytes !== undefined &&
    !(isNonNegativeInt(record.sizeBytes) && Number.isSafeInteger(record.sizeBytes))
  ) {
    return 'invalid sizeBytes'
  }
  if (
    record.checksum !== undefined &&
    (typeof record.checksum !== 'string' || !BACKUP_CHECKSUM_RE.test(record.checksum))
  ) {
    return 'invalid checksum'
  }
  if (
    record.path !== undefined &&
    (typeof record.path !== 'string' || record.path.length > MAX_DAEMON_WS_BACKUP_PATH_CHARS)
  ) {
    return 'invalid path'
  }
  if (record.pruned !== undefined && !isBackupPrunedList(record.pruned)) {
    return 'invalid pruned'
  }
  if (
    record.database !== undefined &&
    (typeof record.database !== 'string' ||
      record.database.length === 0 ||
      record.database.length > MAX_DAEMON_WS_BACKUP_DATABASE_CHARS)
  ) {
    return 'invalid database'
  }
  return null
}

/**
 * Shape only. Whether the report is believed (the policy exists, targets an
 * engine on the reporting server, the artifact path is that policy's own) is
 * decided by `handleBackupRunReport`, which answers `ok: false` rather than
 * closing the socket, so one bad spool file cannot keep a daemon disconnected.
 */
function validateBackupRunReportFields(record: Record<string, unknown>): string | null {
  return validateBackupRunReportRun(record) ?? validateBackupRunReportArtifact(record)
}

const BACKUP_COPY_STATES = new Set(['copied', 'failed'])
const BACKUP_COPY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BACKUP_COPY_OBJECT_KEY_MAX = 1024

/** Shape only; `handleBackupCopyReport` decides whether the report is believed. */
function validateBackupCopyReportFields(record: Record<string, unknown>): string | null {
  if (!isBoundedId(record.id)) return 'invalid id'
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (typeof record.destinationId !== 'string' || !BACKUP_COPY_UUID_RE.test(record.destinationId)) {
    return 'invalid destinationId'
  }
  if (typeof record.managedId !== 'string' || !BACKUP_COPY_UUID_RE.test(record.managedId)) {
    return 'invalid managedId'
  }
  if (!isBackupRunToken(record.backupId)) return 'invalid backupId'
  if (
    record.policyId !== undefined &&
    (typeof record.policyId !== 'string' || !BACKUP_POLICY_ID_RE.test(record.policyId))
  ) {
    return 'invalid policyId'
  }
  if (typeof record.state !== 'string') return 'invalid state'
  if (!BACKUP_COPY_STATES.has(record.state)) return unknownValue('state')
  if (!isIsoTimestamp(record.finishedAt)) return 'invalid finishedAt'
  return validateBackupCopyReportOutcome(record)
}

/** The counts, object key and pruned list of a copy report. */
function validateBackupCopyReportOutcome(record: Record<string, unknown>): string | null {
  if (!(isNonNegativeInt(record.attempts) && Number.isSafeInteger(record.attempts))) {
    return 'invalid attempts'
  }
  if (
    record.sizeBytes !== undefined &&
    !(isNonNegativeInt(record.sizeBytes) && Number.isSafeInteger(record.sizeBytes))
  ) {
    return 'invalid sizeBytes'
  }
  if (
    record.objectKey !== undefined &&
    (typeof record.objectKey !== 'string' || record.objectKey.length > BACKUP_COPY_OBJECT_KEY_MAX)
  ) {
    return 'invalid objectKey'
  }
  if (record.pruned !== undefined && !isBackupPrunedList(record.pruned)) return 'invalid pruned'
  return validateOptionalError(record.error)
}

function isFabricPeerHealth(value: unknown): value is FabricPathPeerHealth {
  return typeof value === 'string' && FABRIC_PEER_HEALTH.has(value)
}

function validateFabricPathObservation(value: unknown): string | null {
  if (!isRecord(value)) return 'invalid path entry'
  if (!isValidWireguardPublicKey(value.publicKey)) {
    return 'invalid path publicKey'
  }
  if (!isFabricPeerHealth(value.health)) return 'invalid path health'
  if (value.endpoint !== undefined && !isValidWireguardEndpoint(value.endpoint)) {
    return 'invalid path endpoint'
  }
  const handshakeIssue = validateOptionalIsoTimestamp(value.lastHandshakeAt, 'path lastHandshakeAt')
  if (handshakeIssue) return handshakeIssue
  if (value.latencyMs !== undefined) {
    if (
      typeof value.latencyMs !== 'number' ||
      !Number.isFinite(value.latencyMs) ||
      value.latencyMs < 0
    ) {
      return 'invalid path latencyMs'
    }
  }
  return null
}

function validateFabricPathsResultFields(record: Record<string, unknown>): string | null {
  const base = validateResultEnvelopeFields(record)
  if (base) return base
  if (!Array.isArray(record.paths)) return 'invalid paths'
  if (record.paths.length > MAX_DAEMON_WS_FABRIC_PATH_ENTRIES) {
    return 'paths exceed max entries'
  }
  for (const entry of record.paths) {
    const issue = validateFabricPathObservation(entry)
    if (issue) return issue
  }
  return null
}

function isBoundedHealthString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DAEMON_WS_MANAGED_HEALTH_FIELD_CHARS
  )
}

function validateOptionalFiniteNumber(value: unknown, field: string): string | null {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `invalid ${field}`
  }
  return null
}

function validateManagedHealthMember(value: unknown): string | null {
  if (!isRecord(value)) return 'invalid member'
  if (!isBoundedHealthString(value.memberId)) return 'invalid member.memberId'
  if (!isBoundedHealthString(value.role)) return 'invalid member.role'
  if (!isBoundedHealthString(value.status)) return 'invalid member.status'
  if (value.replication === undefined) return null
  return validateObservedReplication(value.replication)
}

/** One replication reading, as carried on `managed-health-result` and `managed-health-report`. */
function validateObservedReplication(replication: unknown): string | null {
  if (!isRecord(replication)) return 'invalid member.replication'
  if (!isBoundedHealthString(replication.state)) {
    return 'invalid member.replication.state'
  }
  if (!isIsoTimestamp(replication.observedAt)) {
    return 'invalid member.replication.observedAt'
  }
  return (
    validateOptionalFiniteNumber(replication.lagBytes, 'member.replication.lagBytes') ??
    validateOptionalFiniteNumber(replication.lagSeconds, 'member.replication.lagSeconds') ??
    validateOptionalHealthString(replication.receivedLsn, 'member.replication.receivedLsn') ??
    validateOptionalHealthString(replication.replayLsn, 'member.replication.replayLsn') ??
    validateOptionalFiniteNumber(
      replication.receiveLagBytes,
      'member.replication.receiveLagBytes'
    ) ??
    validateOptionalGtid(replication.receivedGtid, 'member.replication.receivedGtid') ??
    validateOptionalGtid(replication.executedGtid, 'member.replication.executedGtid') ??
    validateOptionalBoolean(replication.fullyApplied, 'member.replication.fullyApplied') ??
    validateLastStreaming(replication.lastStreaming) ??
    validateSlotRetention(replication.slotRetention)
  )
}

function validateSlotRetention(value: unknown): string | null {
  if (value === undefined) return null
  if (!isRecord(value)) return 'invalid member.replication.slotRetention'
  if (value.state !== 'ok' && value.state !== 'lagging' && value.state !== 'critical') {
    return 'invalid member.replication.slotRetention.state'
  }
  if (value.active !== undefined && typeof value.active !== 'boolean') {
    return 'invalid member.replication.slotRetention.active'
  }
  return (
    validateOptionalHealthString(value.slot, 'member.replication.slotRetention.slot') ??
    validateOptionalHealthString(value.walStatus, 'member.replication.slotRetention.walStatus') ??
    validateOptionalFiniteNumber(
      value.retainedBytes,
      'member.replication.slotRetention.retainedBytes'
    ) ??
    validateOptionalFiniteNumber(value.safeBytes, 'member.replication.slotRetention.safeBytes')
  )
}

function validateOptionalGtid(value: unknown, field: string): string | null {
  if (
    value === undefined ||
    // An empty string is an empty GTID set: unknown (the parsers drop it), not a rejection.
    (typeof value === 'string' && value.length <= MAX_DAEMON_WS_MANAGED_GTID_CHARS)
  ) {
    return null
  }
  return `invalid ${field}`
}

function validateOptionalBoolean(value: unknown, field: string): string | null {
  if (value === undefined || typeof value === 'boolean') return null
  return `invalid ${field}`
}

function validateOptionalHealthString(value: unknown, field: string): string | null {
  if (value === undefined || isBoundedHealthString(value)) return null
  return `invalid ${field}`
}

function validateLastStreaming(value: unknown): string | null {
  if (value === undefined) return null
  if (!isRecord(value)) return 'invalid member.replication.lastStreaming'
  if (!isIsoTimestamp(value.at)) {
    return 'invalid member.replication.lastStreaming.at'
  }
  if (typeof value.ageMs !== 'number' || !Number.isFinite(value.ageMs)) {
    return 'invalid member.replication.lastStreaming.ageMs'
  }
  return (
    validateOptionalFiniteNumber(value.lagBytes, 'member.replication.lastStreaming.lagBytes') ??
    validateOptionalFiniteNumber(value.lagSeconds, 'member.replication.lastStreaming.lagSeconds') ??
    validateOptionalFiniteNumber(
      value.receiveLagBytes,
      'member.replication.lastStreaming.receiveLagBytes'
    )
  )
}

/** Max members on one `managed-health-report` (a host's replicas). */
export const MAX_DAEMON_WS_MANAGED_HEALTH_REPORT_MEMBERS = 32

function validateManagedHealthReportMember(value: unknown): string | null {
  if (!isRecord(value)) return 'invalid member'
  if (!isBoundedHealthString(value.managedId)) {
    return 'invalid member.managedId'
  }
  if (!isBoundedHealthString(value.memberId)) return 'invalid member.memberId'
  const down = value.down
  if (down !== undefined && down !== true) return 'invalid member.down'
  // Exactly one of: a reading, or "the engine is down".
  if ((down === true) === (value.replication !== undefined)) {
    return 'member needs exactly one of down or replication'
  }
  return value.replication === undefined ? null : validateObservedReplication(value.replication)
}

function validateManagedHealthReportFields(record: Record<string, unknown>): string | null {
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (!Array.isArray(record.members)) return 'invalid members'
  if (
    record.members.length === 0 ||
    record.members.length > MAX_DAEMON_WS_MANAGED_HEALTH_REPORT_MEMBERS
  ) {
    return 'members count out of range'
  }
  for (const entry of record.members) {
    const issue = validateManagedHealthReportMember(entry)
    if (issue) return issue
  }
  return null
}

/** Max peers on one `fabric-peers-report` (daemon twin `FABRIC_PEER_REPORT_MAX_PEERS`). */
export const MAX_DAEMON_WS_FABRIC_PEER_REPORT_PEERS = 256

const FABRIC_PEER_HEALTH_VALUES: ReadonlySet<string> = new Set<FabricPeerHealth>([
  'healthy',
  'stale',
  'never',
])

/** Linux interface name: at most 15 bytes, no slash or whitespace. */
const FABRIC_PEER_INTERFACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,14}$/

function validateOptionalCounter(value: unknown, field: string): string | null {
  if (value === undefined) return null
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? null
    : `invalid ${field}`
}

function validateFabricPeerHealthValue(value: unknown): string | null {
  if (value === undefined) return null
  if (!isBoundedHealthString(value)) return 'invalid peer.health'
  // A health class this control plane does not know yet: ignore the frame.
  return FABRIC_PEER_HEALTH_VALUES.has(value) ? null : unknownValue('peer.health')
}

function validateFabricPeerLink(value: Record<string, unknown>): string | null {
  if (
    value.endpoint !== undefined &&
    (typeof value.endpoint !== 'string' || !isValidWireguardEndpoint(value.endpoint))
  ) {
    return 'invalid peer.endpoint'
  }
  if (
    value.interface !== undefined &&
    (typeof value.interface !== 'string' || !FABRIC_PEER_INTERFACE_RE.test(value.interface))
  ) {
    return 'invalid peer.interface'
  }
  return null
}

function validateFabricReportPeer(value: unknown): string | null {
  if (!isRecord(value)) return 'invalid peer'
  if (typeof value.publicKey !== 'string' || !isValidWireguardPublicKey(value.publicKey)) {
    return 'invalid peer.publicKey'
  }
  if (value.lastHandshakeAt !== undefined && !isIsoTimestamp(value.lastHandshakeAt)) {
    return 'invalid peer.lastHandshakeAt'
  }
  return (
    validateOptionalCounter(value.transferRx, 'peer.transferRx') ??
    validateOptionalCounter(value.transferTx, 'peer.transferTx') ??
    validateFabricPeerLink(value) ??
    validateFabricPeerHealthValue(value.health)
  )
}

/** A package source's short name, such as `docker` or `php`. */
const REPO_KEY_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/
/** A full OpenPGP fingerprint in hex (v4: 40 digits, v5/v6: 64). */
const REPO_KEY_FINGERPRINT_RE = /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/
/** Most expected fingerprints one `repo-key-changed` frame lists. */
export const MAX_DAEMON_WS_REPO_KEY_EXPECTED = 16

function validateRepoKeyChangedFields(record: Record<string, unknown>): string | null {
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (typeof record.keyName !== 'string' || !REPO_KEY_NAME_RE.test(record.keyName)) {
    return 'invalid keyName'
  }
  if (typeof record.got !== 'string' || !REPO_KEY_FINGERPRINT_RE.test(record.got)) {
    return 'invalid got'
  }
  if (
    !Array.isArray(record.expected) ||
    record.expected.length === 0 ||
    record.expected.length > MAX_DAEMON_WS_REPO_KEY_EXPECTED ||
    !record.expected.every((item) => typeof item === 'string' && REPO_KEY_FINGERPRINT_RE.test(item))
  ) {
    return 'invalid expected'
  }
  return null
}

function validateFabricPeersReportFields(record: Record<string, unknown>): string | null {
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (!isIsoTimestamp(record.observedAt)) return 'invalid observedAt timestamp'
  if (!Array.isArray(record.peers)) return 'invalid peers'
  if (record.peers.length > MAX_DAEMON_WS_FABRIC_PEER_REPORT_PEERS) {
    return 'peers exceed max entries'
  }
  for (const entry of record.peers) {
    const issue = validateFabricReportPeer(entry)
    if (issue) return issue
  }
  return null
}

function validateManagedHealthResultFields(record: Record<string, unknown>): string | null {
  const base = validateOkResultFields(record)
  if (base) return base
  if (record.member === undefined) return null
  return validateManagedHealthMember(record.member)
}

function validateManagedPermissionsResultFields(record: Record<string, unknown>): string | null {
  const base = validateOkResultFields(record)
  if (base) return base
  if (record.permissions === undefined) return null
  if (typeof record.permissions !== 'object' || record.permissions === null) {
    return 'invalid permissions'
  }
  return validateBoundedJson(
    record.permissions,
    MAX_DAEMON_WS_PERMISSIONS_JSON_BYTES,
    'permissions'
  )
}

const NETWORK_CHECK_TEXT_KEYS = ['sourceAddress', 'interface', 'error'] as const

function isOptionalShortText(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 128)
}

function isOptionalLatency(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isNetworkCheckEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const e = entry as Record<string, unknown>
  return (
    typeof e.peerServerId === 'string' &&
    e.peerServerId.length <= 128 &&
    typeof e.address === 'string' &&
    e.address.length <= 64 &&
    typeof e.reachable === 'boolean' &&
    isOptionalLatency(e.latencyMs) &&
    NETWORK_CHECK_TEXT_KEYS.every((key) => isOptionalShortText(e[key]))
  )
}

function validateServerNetworkCheckResultFields(record: Record<string, unknown>): string | null {
  const base = validateOkResultFields(record)
  if (base) return base
  const { results } = record
  if (results === undefined) return null
  if (!Array.isArray(results)) return 'invalid results'
  if (results.length > MAX_DAEMON_WS_NETWORK_CHECK_TARGETS) return 'too many results'
  return results.every(isNetworkCheckEntry) ? null : 'invalid results'
}

/**
 * What the host did with a `deploy-cancel`: `cancelling` (it was told to stop;
 * the deploy command's own outcome says how it ended), `too_late` (the deploy
 * is already switching over and will finish), `not_running` (the host has no
 * such deploy in flight).
 */
export const DEPLOY_CANCEL_OUTCOMES = ['cancelling', 'too_late', 'not_running'] as const
export type DeployCancelOutcome = (typeof DEPLOY_CANCEL_OUTCOMES)[number]

function validateDeployCancelResultFields(record: Record<string, unknown>): string | null {
  const base = validateOkResultFields(record)
  if (base) return base
  if (record.outcome === undefined) return null
  if (typeof record.outcome !== 'string') return 'invalid outcome'
  return (DEPLOY_CANCEL_OUTCOMES as readonly unknown[]).includes(record.outcome)
    ? null
    : unknownValue('outcome')
}

function validateOkResultFields(record: Record<string, unknown>): string | null {
  const base = validateResultEnvelopeFields(record)
  if (base) return base
  if (typeof record.ok !== 'boolean') return 'invalid ok'
  return null
}

function validateUpdateResultFields(record: Record<string, unknown>): string | null {
  const base = validateOkResultFields(record)
  if (base) return base
  if (record.upgradeId !== undefined && !isBoundedId(record.upgradeId)) {
    return 'invalid upgradeId'
  }
  if (record.errorCode !== undefined) {
    if (typeof record.errorCode !== 'string') {
      return 'errorCode must be a string'
    }
    if (record.errorCode.length > MAX_DAEMON_WS_ERROR_CODE_CHARS) {
      return 'errorCode exceeds max length'
    }
  }
  return null
}

function validateCapabilitiesResultFields(record: Record<string, unknown>): string | null {
  const base = validateOkResultFields(record)
  if (base) return base
  const errorIssue = validateOptionalError(record.error)
  if (errorIssue) return errorIssue
  if (record.capabilities === undefined) {
    return record.ok ? 'missing capabilities' : null
  }
  if (!isRecord(record.capabilities)) return 'invalid capabilities'
  if (utf8ByteLength(JSON.stringify(record.capabilities)) > MAX_DAEMON_WS_CAPABILITIES_BYTES) {
    return 'capabilities exceed max size'
  }
  return null
}

function validateCommandAckFields(record: Record<string, unknown>): string | null {
  if (!isBoundedId(record.id)) return 'invalid id'
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (!isIsoTimestamp(record.daemonReceivedAt)) {
    return 'invalid daemonReceivedAt'
  }
  return null
}

function validateCommandOutcomeFields(record: Record<string, unknown>): string | null {
  if (!isBoundedId(record.id)) return 'invalid id'
  if (!isIsoTimestamp(record.at)) return 'invalid at timestamp'
  if (typeof record.ok !== 'boolean') return 'invalid ok'
  const errorIssue = validateOptionalError(record.error)
  if (errorIssue) return errorIssue
  const resultIssue = validateCommandResult(record.result)
  if (resultIssue) return resultIssue
  return (
    validateOptionalIsoTimestamp(record.daemonReceivedAt, 'daemonReceivedAt') ??
    validateOptionalIsoTimestamp(record.daemonRespondedAt, 'daemonRespondedAt')
  )
}

/**
 * Result of {@link validateDaemonInboundFrame}.
 *
 * `ignored` is a well-formed object whose `type`, or an enum value in a known
 * type, this control plane does not know: a newer daemon must not be refused
 * for something optional. The socket stays up. Every other failure still closes
 * with 1008. `notes` are bounded one-line warnings for the caller to log (the
 * `hello` feature filter fills it).
 */
export type DaemonInboundFrameResult =
  | { ok: true; message: DaemonMessage; notes?: readonly string[] }
  | { ok: false; ignored: true; reason: string }
  | { ok: false; ignored: false; reason: string }

function rejectedInboundFrame(reason: string): { ok: false; ignored: false; reason: string } {
  return { ok: false, ignored: false, reason }
}

function ignoredInboundFrame(reason: string): { ok: false; ignored: true; reason: string } {
  return { ok: false, ignored: true, reason }
}

/**
 * Strict inbound WebSocket frame validator. Checks frame size, message type,
 * required fields, timestamp format, identifier lengths, and per-field caps
 * before any cell storage / rate-limit bookkeeping runs.
 *
 * An unrecognized `type` on an otherwise well-formed object is `ignored`
 * (the peer learned a message this process has not). Oversized frames,
 * invalid JSON, a non-object body, and a known type that fails field
 * validation stay rejections.
 */
export function validateDaemonInboundFrame(raw: string): DaemonInboundFrameResult {
  if (utf8ByteLength(raw) > MAX_DAEMON_WS_FRAME_BYTES) {
    return rejectedInboundFrame('frame exceeds max size')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return rejectedInboundFrame('invalid json')
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return rejectedInboundFrame('invalid message shape')
  }

  if (!(DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has(parsed.type)) {
    return ignoredInboundFrame(`disallowed type ${parsed.type}`)
  }

  const typeIssue = validateInboundMessageFields(parsed)
  if (typeIssue) {
    return typeIssue.startsWith(UNKNOWN_VALUE_PREFIX)
      ? ignoredInboundFrame(typeIssue)
      : rejectedInboundFrame(typeIssue)
  }

  if (parsed.type === 'hello' && Array.isArray(parsed.features)) {
    const { features, note } = filterHelloFeatures(parsed.features)
    const message = { ...parsed, features } as DaemonMessage
    return note ? { ok: true, message, notes: [note] } : { ok: true, message }
  }

  return { ok: true, message: parsed as DaemonMessage }
}

function validateInboundMessageFields(record: Record<string, unknown>): string | null {
  switch (record.type) {
    case 'hello':
      return validateHelloFields(record)
    case 'heartbeat':
      return validatePresenceFields(record)
    case 'addresses-result':
      return validateAddressesResultFields(record)
    case 'managed-logs-result':
    case 'container-logs-result':
      return validateManagedLogsResultFields(record)
    case 'managed-health-result':
      return validateManagedHealthResultFields(record)
    case 'managed-permissions-result':
      return validateManagedPermissionsResultFields(record)
    case 'server-network-check-result':
      return validateServerNetworkCheckResultFields(record)
    case 'repo-read-result':
      return validateRepoReadResultFields(record)
    case 'repo-default-branch-result':
      return validateRepoDefaultBranchResultFields(record)
    case 'managed-ha-event':
      return validateManagedHaEventFields(record)
    case 'managed-health-report':
      return validateManagedHealthReportFields(record)
    case 'fabric-peers-report':
      return validateFabricPeersReportFields(record)
    case 'repo-key-changed':
      return validateRepoKeyChangedFields(record)
    case 'topology-report':
      return validateTopologyReportFields(record)
    case 'acme-issuance-event':
    case 'instance-acme-issuance-event':
      return validateAcmeIssuanceEventFields(record)
    case 'acme-issue-event':
      return validateAcmeIssueEventFields(record)
    case 'acme-proof-forward-ready':
    case 'acme-proof-forward-failed':
      return validateAcmeProofForwardReportFields(record)
    case 'backup-run-report':
      return validateBackupRunReportFields(record)
    case 'backup-copy-report':
      return validateBackupCopyReportFields(record)
    case 'fabric-paths-result':
      return validateFabricPathsResultFields(record)
    case 'dev-sync-result':
    case 'tunnel-token-result':
    case 'public-urls-update-result':
    case 'metrics-live-start-result':
    case 'metrics-live-stop-result':
    case 'topology-overrides-update-result':
    case 'capability-plan-update-result':
    case 'capability-plan-clear-result':
      return validateOkResultFields(record)
    case 'deploy-cancel-result':
      return validateDeployCancelResultFields(record)
    case 'update-result':
    case 'instance-update-result':
      return validateUpdateResultFields(record)
    case 'metrics-capabilities-result':
      return validateCapabilitiesResultFields(record)
    case 'command-ack':
      return validateCommandAckFields(record)
    case 'command-outcome':
      return validateCommandOutcomeFields(record)
    case 'update-progress':
      return validateUpdateProgressFields(record)
    case 'command-progress':
      return validateCommandProgressFields(record)
    default:
      return `disallowed type ${String(record.type)}`
  }
}

function validateManagedLogsEnvelope(
  inbound: Extract<DaemonInboundEnvelope, { kind: 'managed-logs-result' | 'container-logs-result' }>
): string | null {
  if (inbound.logs.length > MAX_DAEMON_WS_LOGS_CHARS) {
    return 'logs exceed max length'
  }
  return validateOptionalError(inbound.error)
}

/**
 * Size-check a repo read before it is handed to the caller.
 *
 * The cap is on the **total** across files, not per file: eight files just
 * under a per-file limit would still be a frame nobody asked for.
 */
function validateRepoReadEnvelope(
  inbound: Extract<DaemonInboundEnvelope, { kind: 'repo-read-result' }>
): string | null {
  let bytes = 0
  for (const file of inbound.files ?? []) {
    bytes += utf8ByteLength(file.content ?? '')
    if (bytes > MAX_DAEMON_WS_REPO_READ_BYTES) {
      return 'repo read exceeds max bytes'
    }
  }
  if ((inbound.entries ?? []).length > MAX_DAEMON_WS_REPO_READ_ENTRIES) {
    return 'repo read entries exceed max'
  }
  return validateOptionalError(inbound.error)
}

function validateFabricPathsEnvelope(
  inbound: Extract<DaemonInboundEnvelope, { kind: 'fabric-paths-result' }>
): string | null {
  if (inbound.paths.length > MAX_DAEMON_WS_FABRIC_PATH_ENTRIES) {
    return 'paths exceed max entries'
  }
  for (const entry of inbound.paths) {
    const issue = validateFabricPathObservation(entry)
    if (issue) return issue
  }
  return validateOptionalError(inbound.error)
}

function validateCommandAckEnvelope(
  inbound: Extract<DaemonInboundEnvelope, { kind: 'command-ack' }>
): string | null {
  if (!isIsoTimestamp(inbound.daemonReceivedAt)) {
    return 'invalid daemonReceivedAt'
  }
  return null
}

function validateCapabilitiesEnvelope(
  inbound: Extract<DaemonInboundEnvelope, { kind: 'metrics-capabilities-result' }>
): string | null {
  if (inbound.capabilities !== undefined) {
    if (utf8ByteLength(JSON.stringify(inbound.capabilities)) > MAX_DAEMON_WS_CAPABILITIES_BYTES) {
      return 'capabilities exceed max size'
    }
  }
  return validateOptionalError(inbound.error)
}

function validateInboundEnvelopeKind(inbound: DaemonInboundEnvelope): string | null {
  switch (inbound.kind) {
    case 'managed-logs-result':
    case 'container-logs-result':
      return validateManagedLogsEnvelope(inbound)
    case 'repo-read-result':
      return validateRepoReadEnvelope(inbound)
    case 'repo-default-branch-result':
    case 'managed-health-result':
    case 'managed-permissions-result':
    case 'server-network-check-result':
      return validateOptionalError(inbound.error)
    case 'fabric-paths-result':
      return validateFabricPathsEnvelope(inbound)
    case 'command-outcome':
      return validateOptionalError(inbound.error) ?? validateCommandResult(inbound.result)
    case 'dev-sync-result':
    case 'tunnel-token-result':
    case 'public-urls-update-result':
    case 'update-result':
    case 'instance-update-result':
    case 'metrics-live-start-result':
    case 'metrics-live-stop-result':
    case 'topology-overrides-update-result':
    case 'capability-plan-update-result':
    case 'capability-plan-clear-result':
    case 'deploy-cancel-result':
      return validateOptionalError(inbound.error)
    case 'metrics-capabilities-result':
      return validateCapabilitiesEnvelope(inbound)
    case 'command-ack':
      return validateCommandAckEnvelope(inbound)
    case 'addresses-result':
      return null
    default:
      return 'unknown envelope kind'
  }
}

/**
 * Re-check normalized inbound envelope field sizes before Redis/DO persistence.
 * Callers that already ran {@link validateDaemonInboundFrame} still pass this
 * cheap guard so a forged envelope cannot bypass wire validation.
 */
export function validateDaemonInboundEnvelope(
  inbound: DaemonInboundEnvelope
): { ok: true } | { ok: false; reason: string } {
  if (!isBoundedId(inbound.requestId)) {
    return { ok: false, reason: 'invalid requestId' }
  }
  if (!isIsoTimestamp(inbound.at)) {
    return { ok: false, reason: 'invalid at timestamp' }
  }
  const kindIssue = validateInboundEnvelopeKind(inbound)
  if (kindIssue) return { ok: false, reason: kindIssue }
  return { ok: true }
}

/** Auto-response ping/pong pair — handled by the runtime without waking the DO. */
export const DAEMON_CELL_PING = '{"type":"ping"}'
export const DAEMON_CELL_PONG = '{"type":"pong"}'

/** Per-outbox-entry identity for queue send/ack/resend semantics. */
export type OutboxDeliveryId = string // NOSONAR typescript:S6564 — semantic alias for delivery queue keys

/** Correlation/idempotency key shared by all frames in a multi-message request. */
export type OutboundRequestId = string // NOSONAR typescript:S6564 — semantic alias for request correlation

type OutboundEnvelopeBase = {
  /** Unique outbox entry key; distinct for every queued delivery. */
  deliveryId: OutboxDeliveryId
  /** Correlates multi-frame requests (e.g. dev-sync chunks) and inbound acks. */
  requestId: OutboundRequestId
  at: string
}

/** Cell-internal outbound envelope (normalized form, distinct from wire `DaemonMessage`). */
export type DaemonOutboundEnvelope =
  | (OutboundEnvelopeBase & { kind: 'addresses-request' })
  | (OutboundEnvelopeBase & {
      kind: 'managed-logs-request'
      managedId: string
      tail: number
    })
  | (OutboundEnvelopeBase & {
      kind: 'managed-health-request'
      managedId: string
      memberId: string
      role: 'primary' | 'replica'
      engine: string
    })
  | (OutboundEnvelopeBase & {
      kind: 'managed-permissions-request'
      managedId: string
      engine: string
      logins: string[]
      databases: string[]
    })
  | (OutboundEnvelopeBase & {
      kind: 'server-network-check-request'
      targets: ServerNetworkCheckTarget[]
    })
  | (OutboundEnvelopeBase & {
      kind: 'container-logs-request'
      containerId: string
      tail: number
    })
  | (OutboundEnvelopeBase & {
      kind: 'repo-read-request'
      cloneUrl: string
      ref: string
      paths: string[]
      listPath?: string
      maxBytesPerFile: number
      /** `tpdaemon.…` sealed clone secret, or absent for a public repo. */
      credential?: string
      credentialKind?: string
      credentialUsername?: string
    })
  | (OutboundEnvelopeBase & {
      kind: 'repo-default-branch-request'
      /** Anonymous only — no credential field, unlike `repo-read-request`. */
      cloneUrl: string
    })
  | (OutboundEnvelopeBase & {
      kind: 'fabric-paths-request'
      fabricId: string
      probeMs: number
      candidates: FabricPathWireCandidate[]
    })
  | (OutboundEnvelopeBase & {
      kind: 'dev-sync'
      phase: 'begin'
      totalChunks: number
      totalBytes: number
    })
  | (OutboundEnvelopeBase & {
      kind: 'dev-sync'
      phase: 'chunk'
      index: number
      data: string
    })
  | (OutboundEnvelopeBase & { kind: 'dev-sync'; phase: 'end' })
  | (OutboundEnvelopeBase & {
      kind: 'tunnel-token'
      /** Legacy plaintext; also the empty teardown token. */
      token?: string
      /** `tpdaemon` envelope for a non-empty token (sealed-instance-secrets-v1). */
      tokenEnvelope?: string
    })
  | (OutboundEnvelopeBase & {
      kind: 'public-urls-update'
      urls: string[]
      hostnames?: InstanceHostnameWireEntry[]
      instanceAcme?: InstanceAcmeWireSettings
    })
  | (OutboundEnvelopeBase & {
      kind: 'metrics-live-start'
      leaseId: string
      intervalSeconds: number
      expiresAt: string
    })
  | (OutboundEnvelopeBase & { kind: 'metrics-live-stop'; leaseId: string })
  | (OutboundEnvelopeBase & { kind: 'metrics-capabilities-request' })
  | (OutboundEnvelopeBase & {
      kind: 'topology-overrides-update'
      overrides: TopologyOverridesUpdatePayload
    })
  | (OutboundEnvelopeBase & {
      kind: 'capability-plan-update'
      plan: CapabilityPlanUpdatePayload
      generation: number
    })
  | (OutboundEnvelopeBase & { kind: 'capability-plan-clear' })
  | (OutboundEnvelopeBase & { kind: 'deploy-cancel'; commandId: string })
  | (OutboundEnvelopeBase & {
      kind: 'update'
      channel?: string
      updateUrl?: string
      updateSha256?: string
      upgradeId?: string
      manifestUrl?: string
      targetCommit?: string
    })
  | (OutboundEnvelopeBase & {
      kind: 'instance-update'
      channel?: string
      manifestUrl?: string
      uiManifestUrl?: string
      targetVersion?: string
      upgradeId?: string
      targetCommit?: string
    })
  | (OutboundEnvelopeBase & {
      kind: 'acme-issue-request'
      /** The order's id (wire `requestId`); `requestId` above is the cell's own correlation key. */
      acmeRequestId: string
      tlsId: string
      names: string[]
      directory: 'production' | 'staging'
      contactEmail: string
      startByIso: string
      helpers: AcmeProofHelper[]
    })
  | (OutboundEnvelopeBase & {
      kind: 'acme-proof-forward'
      acmeRequestId: string
      names: string[]
      targetAddress: string
      expiresAtIso: string
    })
  | (OutboundEnvelopeBase & { kind: 'acme-proof-forward-end'; acmeRequestId: string })
  | (OutboundEnvelopeBase & { kind: 'echo'; payload: unknown })
  | (OutboundEnvelopeBase & {
      kind: 'command-dispatch'
      commandId: string
      commandType: string
      payload: unknown
    })

/** Cell-internal inbound envelope (normalized form, distinct from wire `DaemonMessage`). */
export type DaemonInboundEnvelope =
  | {
      kind: 'addresses-result'
      requestId: string
      at: string
      ips: ServerReportedIp[]
    }
  | {
      kind: 'managed-logs-result'
      requestId: string
      at: string
      logs: string
      error?: string
    }
  | {
      kind: 'managed-health-result'
      requestId: string
      at: string
      ok: boolean
      member?: ManagedHealthObservedMember
      error?: string
    }
  | {
      kind: 'managed-permissions-result'
      requestId: string
      at: string
      ok: boolean
      permissions?: ManagedPermissionsObserved
      error?: string
    }
  | {
      kind: 'server-network-check-result'
      requestId: string
      at: string
      ok: boolean
      results?: ServerNetworkCheckEntry[]
      error?: string
    }
  | {
      kind: 'container-logs-result'
      requestId: string
      at: string
      logs: string
      error?: string
    }
  | {
      kind: 'repo-read-result'
      requestId: string
      at: string
      ok: boolean
      commitSha?: string
      files?: {
        path: string
        found: boolean
        content?: string
        bytes?: number
        reason?: string
      }[]
      entries?: { path: string; kind: string; bytes?: number }[]
      error?: string
    }
  | {
      kind: 'repo-default-branch-result'
      requestId: string
      at: string
      ok: boolean
      defaultBranch?: string | null
      error?: string
    }
  | {
      kind: 'fabric-paths-result'
      requestId: string
      at: string
      paths: FabricPathWireObservation[]
      error?: string
    }
  | {
      kind: 'dev-sync-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
    }
  | {
      kind: 'tunnel-token-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
    }
  | {
      kind: 'public-urls-update-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
    }
  | {
      kind: 'metrics-live-start-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
    }
  | {
      kind: 'metrics-live-stop-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
    }
  | {
      kind: 'metrics-capabilities-result'
      requestId: string
      at: string
      ok: boolean
      capabilities?: Record<string, unknown>
      error?: string
    }
  | {
      kind: 'topology-overrides-update-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
    }
  | {
      kind: 'capability-plan-update-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
    }
  | {
      kind: 'capability-plan-clear-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
    }
  | {
      kind: 'deploy-cancel-result'
      requestId: string
      at: string
      ok: boolean
      outcome?: DeployCancelOutcome
      error?: string
    }
  | {
      kind: 'update-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
      errorCode?: string
      upgradeId?: string
    }
  | {
      kind: 'instance-update-result'
      requestId: string
      at: string
      ok: boolean
      error?: string
      errorCode?: string
      upgradeId?: string
    }
  | {
      kind: 'command-ack'
      requestId: string
      at: string
      daemonReceivedAt: string
    }
  | {
      kind: 'command-outcome'
      requestId: string
      at: string
      ok: boolean
      result?: unknown
      error?: string
      daemonReceivedAt?: string
      daemonRespondedAt?: string
    }

export function parseDaemonMessage(raw: string): DaemonMessage | null {
  try {
    return JSON.parse(raw) as DaemonMessage
  } catch {
    return null
  }
}

export function wireMessageToInboundEnvelope(msg: DaemonMessage): DaemonInboundEnvelope | null {
  switch (msg.type) {
    case 'hello':
    case 'heartbeat':
    case 'managed-ha-event':
    case 'managed-health-report':
    case 'fabric-peers-report':
    case 'repo-key-changed':
    case 'topology-report':
    case 'acme-issuance-event':
    case 'instance-acme-issuance-event':
    case 'acme-issue-event':
    case 'acme-proof-forward-ready':
    case 'acme-proof-forward-failed':
    case 'update-progress':
    case 'command-progress':
      // Fire-and-forget (or session setup). Not a correlated request.
      // `update-progress` and `command-progress` must stay in this list:
      // neither completes a pending update or command.
      return null

    case 'addresses-result':
      return {
        kind: 'addresses-result',
        requestId: msg.id,
        at: msg.at,
        ips: msg.ips,
      }
    case 'managed-logs-result':
      return {
        kind: 'managed-logs-result',
        requestId: msg.id,
        at: msg.at,
        logs: msg.logs,
        error: msg.error,
      }
    case 'managed-health-result':
      return {
        kind: 'managed-health-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        member: msg.member,
        error: msg.error,
      }
    case 'managed-permissions-result':
      return {
        kind: 'managed-permissions-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        permissions: msg.permissions,
        error: msg.error,
      }
    case 'server-network-check-result':
      return {
        kind: 'server-network-check-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        results: msg.results,
        error: msg.error,
      }
    case 'container-logs-result':
      return {
        kind: 'container-logs-result',
        requestId: msg.id,
        at: msg.at,
        logs: msg.logs,
        error: msg.error,
      }
    case 'repo-read-result':
      return {
        kind: 'repo-read-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        commitSha: msg.commitSha,
        files: msg.files,
        entries: msg.entries,
        error: msg.error,
      }
    case 'repo-default-branch-result':
      return {
        kind: 'repo-default-branch-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        defaultBranch: msg.defaultBranch,
        error: msg.error,
      }
    case 'fabric-paths-result':
      return {
        kind: 'fabric-paths-result',
        requestId: msg.id,
        at: msg.at,
        paths: msg.paths,
        error: msg.error,
      }
    case 'metrics-capabilities-result':
      return {
        kind: 'metrics-capabilities-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        capabilities: msg.capabilities,
        error: msg.error,
      }
    case 'dev-sync-result':
    case 'tunnel-token-result':
    case 'public-urls-update-result':
    case 'metrics-live-start-result':
    case 'metrics-live-stop-result':
    case 'topology-overrides-update-result':
    case 'capability-plan-update-result':
    case 'capability-plan-clear-result':
      return {
        kind: msg.type,
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
      } as DaemonInboundEnvelope
    case 'deploy-cancel-result':
      return {
        kind: 'deploy-cancel-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        ...(msg.outcome === undefined ? {} : { outcome: msg.outcome }),
        error: msg.error,
      }
    case 'update-result':
      return {
        kind: 'update-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
        ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
        ...(msg.upgradeId !== undefined ? { upgradeId: msg.upgradeId } : {}),
      }
    case 'instance-update-result':
      return {
        kind: 'instance-update-result',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        error: msg.error,
        ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
        ...(msg.upgradeId !== undefined ? { upgradeId: msg.upgradeId } : {}),
      }
    case 'command-ack':
      return {
        kind: 'command-ack',
        requestId: msg.id,
        at: msg.at,
        daemonReceivedAt: msg.daemonReceivedAt,
      }
    case 'command-outcome':
      return {
        kind: 'command-outcome',
        requestId: msg.id,
        at: msg.at,
        ok: msg.ok,
        result: msg.result,
        error: msg.error,
        daemonReceivedAt: msg.daemonReceivedAt,
        daemonRespondedAt: msg.daemonRespondedAt,
      }
    default:
      return null
  }
}

/** One envelope variant, addressed by its `kind`. */
type OutboundEnvelopeOf<K extends DaemonOutboundEnvelope['kind']> = Extract<
  DaemonOutboundEnvelope,
  { kind: K }
>

/**
 * The credential fields ride along only when the source has one — a `null` or
 * an empty string would read as "clone anonymously", which is a different
 * request.
 */
function repoReadRequestMessage(env: OutboundEnvelopeOf<'repo-read-request'>): DaemonMessage {
  return {
    type: 'repo-read-request',
    id: env.requestId,
    cloneUrl: env.cloneUrl,
    ref: env.ref,
    paths: env.paths.slice(0, MAX_DAEMON_WS_REPO_READ_PATHS),
    ...(env.listPath === undefined ? {} : { listPath: env.listPath }),
    maxBytesPerFile: env.maxBytesPerFile,
    ...(env.credential === undefined ? {} : { credential: env.credential }),
    ...(env.credentialKind === undefined ? {} : { credentialKind: env.credentialKind }),
    ...(env.credentialUsername === undefined ? {} : { credentialUsername: env.credentialUsername }),
    at: env.at,
  }
}

/** One dev-sync envelope carries the phase; the wire has a type per phase. */
function devSyncMessage(env: OutboundEnvelopeOf<'dev-sync'>): DaemonMessage {
  if (env.phase === 'begin') {
    return {
      type: 'dev-sync-begin',
      id: env.requestId,
      totalChunks: env.totalChunks,
      totalBytes: env.totalBytes,
      at: env.at,
    }
  }
  if (env.phase === 'chunk') {
    return {
      type: 'dev-sync-chunk',
      id: env.requestId,
      index: env.index,
      data: env.data,
      at: env.at,
    }
  }
  return { type: 'dev-sync-end', id: env.requestId, at: env.at }
}

/**
 * Omit `hostnames` and `instanceAcme` when absent so an older daemon sees
 * the flat `urls` list it already understands.
 */
function publicUrlsUpdateMessage(env: OutboundEnvelopeOf<'public-urls-update'>): DaemonMessage {
  const message = {
    type: 'public-urls-update' as const,
    id: env.requestId,
    urls: env.urls,
    at: env.at,
  }
  if (env.hostnames === undefined) return message
  if (env.instanceAcme === undefined) {
    return { ...message, hostnames: env.hostnames }
  }
  return {
    ...message,
    hostnames: env.hostnames,
    instanceAcme: env.instanceAcme,
  }
}

/** An absent field means "keep what you have", not "clear it". */
function instanceUpdateMessage(env: OutboundEnvelopeOf<'instance-update'>): DaemonMessage {
  return {
    type: 'instance-update',
    id: env.requestId,
    at: env.at,
    ...(env.channel !== undefined ? { channel: env.channel } : {}),
    ...(env.manifestUrl !== undefined ? { manifestUrl: env.manifestUrl } : {}),
    ...(env.uiManifestUrl !== undefined ? { uiManifestUrl: env.uiManifestUrl } : {}),
    ...(env.targetVersion !== undefined ? { targetVersion: env.targetVersion } : {}),
    ...(env.upgradeId !== undefined ? { upgradeId: env.upgradeId } : {}),
    ...(env.targetCommit !== undefined ? { targetCommit: env.targetCommit } : {}),
  }
}

function updateMessage(env: OutboundEnvelopeOf<'update'>): DaemonMessage {
  return {
    type: 'update',
    id: env.requestId,
    at: env.at,
    ...(env.channel !== undefined ? { channel: env.channel } : {}),
    ...(env.updateUrl !== undefined ? { updateUrl: env.updateUrl } : {}),
    ...(env.updateSha256 !== undefined ? { updateSha256: env.updateSha256 } : {}),
    ...(env.upgradeId !== undefined ? { upgradeId: env.upgradeId } : {}),
    ...(env.manifestUrl !== undefined ? { manifestUrl: env.manifestUrl } : {}),
    ...(env.targetCommit !== undefined ? { targetCommit: env.targetCommit } : {}),
  }
}

export function outboundEnvelopeToWireMessage(env: DaemonOutboundEnvelope): DaemonMessage {
  switch (env.kind) {
    case 'addresses-request':
      return { type: 'addresses-request', id: env.requestId, at: env.at }
    case 'metrics-capabilities-request':
      return {
        type: 'metrics-capabilities-request',
        id: env.requestId,
        at: env.at,
      }
    case 'managed-logs-request':
      return {
        type: 'managed-logs-request',
        id: env.requestId,
        managedId: env.managedId,
        tail: env.tail,
        at: env.at,
      }
    case 'managed-health-request':
      return {
        type: 'managed-health-request',
        id: env.requestId,
        managedId: env.managedId,
        memberId: env.memberId,
        role: env.role,
        engine: env.engine,
        at: env.at,
      }
    case 'managed-permissions-request':
      return {
        type: 'managed-permissions-request',
        id: env.requestId,
        managedId: env.managedId,
        engine: env.engine,
        logins: env.logins,
        databases: env.databases,
        at: env.at,
      }
    case 'server-network-check-request':
      return {
        type: 'server-network-check-request',
        id: env.requestId,
        targets: env.targets,
        at: env.at,
      }
    case 'acme-issue-request':
      return {
        type: 'acme-issue-request',
        requestId: env.acmeRequestId,
        tlsId: env.tlsId,
        names: env.names,
        directory: env.directory,
        contactEmail: env.contactEmail,
        startByIso: env.startByIso,
        helpers: env.helpers,
        at: env.at,
      }
    case 'acme-proof-forward':
      return {
        type: 'acme-proof-forward',
        requestId: env.acmeRequestId,
        names: env.names,
        targetAddress: env.targetAddress,
        expiresAtIso: env.expiresAtIso,
        at: env.at,
      }
    case 'acme-proof-forward-end':
      return { type: 'acme-proof-forward-end', requestId: env.acmeRequestId, at: env.at }
    case 'container-logs-request':
      return {
        type: 'container-logs-request',
        id: env.requestId,
        containerId: env.containerId,
        tail: env.tail,
        at: env.at,
      }
    case 'repo-read-request':
      return repoReadRequestMessage(env)
    case 'repo-default-branch-request':
      return {
        type: 'repo-default-branch-request',
        id: env.requestId,
        cloneUrl: env.cloneUrl,
        at: env.at,
      }
    case 'fabric-paths-request':
      return {
        type: 'fabric-paths-request',
        id: env.requestId,
        fabricId: env.fabricId,
        probeMs: env.probeMs,
        candidates: env.candidates.slice(0, MAX_DAEMON_WS_FABRIC_PATH_ENTRIES).map((candidate) => ({
          publicKey: candidate.publicKey,
          endpoints: candidate.endpoints.slice(0, MAX_DAEMON_WS_FABRIC_PATH_CANDIDATES),
        })),
        at: env.at,
      }
    case 'dev-sync':
      return devSyncMessage(env)
    case 'tunnel-token':
      return {
        type: 'tunnel-token',
        id: env.requestId,
        ...(env.token !== undefined ? { token: env.token } : {}),
        ...(env.tokenEnvelope !== undefined ? { tokenEnvelope: env.tokenEnvelope } : {}),
        at: env.at,
      }
    case 'public-urls-update':
      return publicUrlsUpdateMessage(env)
    case 'metrics-live-start':
      return {
        type: 'metrics-live-start',
        id: env.requestId,
        leaseId: env.leaseId,
        intervalSeconds: env.intervalSeconds,
        expiresAt: env.expiresAt,
        at: env.at,
      }
    case 'metrics-live-stop':
      return {
        type: 'metrics-live-stop',
        id: env.requestId,
        leaseId: env.leaseId,
        at: env.at,
      }
    case 'topology-overrides-update':
      return {
        type: 'topology-overrides-update',
        id: env.requestId,
        overrides: env.overrides,
        at: env.at,
      }
    case 'capability-plan-update':
      return {
        type: 'capability-plan-update',
        id: env.requestId,
        plan: env.plan,
        generation: env.generation,
        at: env.at,
      }
    case 'capability-plan-clear':
      return {
        type: 'capability-plan-clear',
        id: env.requestId,
        at: env.at,
      }
    case 'deploy-cancel':
      return {
        type: 'deploy-cancel',
        id: env.requestId,
        commandId: env.commandId,
        at: env.at,
      }
    case 'update':
      return updateMessage(env)
    case 'instance-update':
      return instanceUpdateMessage(env)
    case 'echo':
      return { type: 'echo', payload: env.payload, at: env.at }
    case 'command-dispatch':
      return {
        type: 'command-dispatch',
        id: env.requestId,
        commandId: env.commandId,
        commandType: env.commandType,
        payload: env.payload,
        at: env.at,
      }
  }
}

export function generateRequestId(): OutboundRequestId {
  return crypto.randomUUID()
}

export function generateDeliveryId(): OutboxDeliveryId {
  return crypto.randomUUID()
}
