import type { Db } from '../../../db/connection.ts'
import type { IngressMode, IngressProviderId } from '../../../features/install/ingress-modes.ts'
import type { IngressAccountRecord } from './accounts.ts'
import type { EdgeGate } from './gate.ts'
import type {
  InstanceHostnameRecord,
  InstanceHostnameSource,
} from '../../../features/install/instance-hostnames.ts'

/** Who presents the certificate a visitor's browser sees. */
export type VisitorCertificateIssuer = 'panel' | 'edge' | 'overlay' | 'panel-passthrough'
/** Whether the origin (the panel) needs its own certificate behind the edge. */
export type OriginCertificateNeed = 'same' | 'optional' | 'required-strict' | 'required-public'
/** Where the panel reads the visitor's address from. */
export type VisitorIpSource =
  | 'socket-peer'
  | 'cf-connecting-ip-loopback'
  | 'cf-connecting-ip-ranges'
  | 'x-real-ip-edge-list'
  | 'overlay-peer'
  | 'proxy-protocol'
export type ApiDriven = 'none' | 'token' | 'account-key'

/** Static facts about a connection mode. The planner and, later, the UI read these. */
export type IngressCapabilities = {
  mode: IngressMode
  /** False: the registry refuses preflight and apply with "not available yet". */
  implemented: boolean
  originMustBePublic: boolean
  visitorCertificateIssuer: VisitorCertificateIssuer
  originCertificate: OriginCertificateNeed
  visitorIpSource: VisitorIpSource
  defaultPublicPort: 443 | 8443
  heartbeatSeconds: 25 | 60
  /** The idle limit the heartbeat must beat; null when none is known. */
  idleLimitSeconds: number | null
  apiDriven: ApiDriven
  /** Which provider account the mode needs, if any. */
  provider: IngressProviderId | null
  allowedCertificateSources: readonly InstanceHostnameSource[]
  /** True: served through an edge, so the go-live gate applies and the UI hides it until the gate opens. */
  isEdge: boolean
}

export type IngressCause =
  | 'not-available'
  | 'invalid-hostname'
  | 'gate-closed'
  | 'account-missing'
  | 'token-invalid'
  | 'scope-missing'
  | 'zone-not-found'
  | 'dns-conflict'
  | 'provider-error'
  | 'provider-rate-limited'
  | 'daemon-offline'
  | 'edge-unreachable'

/**
 * What an API-driven provider needs besides the hostname. Built per request
 * or per tick by `service.ts`; listener modes ignore it. The provider token
 * is reachable only through `openToken` and never stored or returned.
 */
export type IngressDeps = {
  db: Db
  now: () => Date
  fetch: typeof fetch
  gate: EdgeGate
  /** Whether the daemon on the control plane host is connected (it runs the connector). */
  colocatedDaemonConnected: () => Promise<boolean>
  /** Hand a tunnel run token to the co-located daemon only; '' stops the connector. */
  pushRunToken: (token: string) => Promise<{ ok: true } | { ok: false; error: string }>
  account: IngressAccountRecord | null
  openToken: (account: IngressAccountRecord) => Promise<string>
  /** Every hostname row with its stored provider state: edge modes share one setup per account. */
  hostnames: readonly HostnameWithState[]
  /** Stable id of this install, for provider resource names. */
  instanceId: string
  /** True when the served identity document is this control plane's own (edge self-check). */
  isOwnIdentity: (body: string, signatureHeader: string | null) => Promise<boolean>
}

/** A hostname row plus the provider state `apply` returned last time (`origin.ingress_state.provider`). */
export type HostnameWithState = InstanceHostnameRecord & {
  providerState: Record<string, unknown> | null
}

export type IngressContext = {
  hostname: InstanceHostnameRecord
  /** Absent for the pure listener checks; required by API-driven providers. */
  deps?: IngressDeps
  /** Apply may replace a DNS record that already holds the name (the operator agreed). */
  replaceExisting?: boolean
}

/** Plain-words detail, sentence case. */
export type PreflightCheck = { id: string; ok: boolean; detail: string }
export type PreflightResult = { ok: boolean; checks: PreflightCheck[] }
export type ApplyResult =
  { ok: true; state: Record<string, unknown> } | { ok: false; cause: IngressCause; detail: string }
export type IngressPhase =
  'not-applied' | 'applying' | 'healthy' | 'degraded' | 'failed' | 'removed'
export type IngressStatus = {
  phase: IngressPhase
  cause?: IngressCause
  detail?: string
  facts?: Record<string, string | number | boolean>
}

export interface IngressProvider {
  readonly mode: IngressMode
  readonly capabilities: IngressCapabilities
  preflight(ctx: IngressContext): Promise<PreflightResult>
  /** Idempotent. Writes nothing itself; returns the state the caller stores. */
  apply(ctx: IngressContext): Promise<ApplyResult>
  status(ctx: IngressContext): Promise<IngressStatus>
  /** Idempotent; tolerates an already removed setup. */
  remove(ctx: IngressContext): Promise<void>
}
