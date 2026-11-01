import type { IngressMode, IngressProviderId } from '../../../features/install/ingress-modes.ts'
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

export type IngressCause = 'not-available' | 'invalid-hostname'

export type IngressContext = {
  hostname: InstanceHostnameRecord
}

/** Plain-words detail, sentence case. */
export type PreflightCheck = { id: string; ok: boolean; detail: string }
export type PreflightResult = { ok: boolean; checks: PreflightCheck[] }
export type ApplyResult =
  { ok: true; state: Record<string, unknown> } | { ok: false; cause: IngressCause; detail: string }
export type IngressStatus = {
  phase: 'not-applied' | 'applying' | 'healthy' | 'degraded' | 'failed' | 'removed'
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
