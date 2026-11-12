/**
 * The daemon WebSocket upgrade (`GET /ws/daemon/v1`, empty body) carries the
 * same `X-TurboPanel-Daemon-Signature` as a REST request. It is required when
 * the token is bound to the daemon key (`cnf`) or the server already proved
 * itself with its key (`trust_level` 2); its nonce is used once, so a copied
 * upgrade cannot be replayed. Shared by `workers-ws.ts` and `deno-ws.ts`.
 */
import type { Db } from '../../db/connection.ts'
import { markRequestNonceUsed } from '../../features/servers/daemon-nonce.ts'
import type { PanelIdentity } from '../../lib/panel-identity/identity.ts'
import { DAEMON_PROOF_TRUST_LEVEL } from './attach-proof.ts'
import {
  REQUEST_MAX_SKEW_SECONDS,
  daemonKeyThumbprint,
  DAEMON_SIGNATURE_HEADER,
  verifyDaemonRequest,
} from './request-signature.ts'

/** The control plane keys a pinned daemon may name: current, and next when set. */
export function panelKeyFingerprints(identity: {
  current: { kid: string }
  next: { kid: string } | null
}): string[] {
  return identity.next ? [identity.current.kid, identity.next.kid] : [identity.current.kid]
}

/** The fingerprints from a lazily loaded identity; null when no identity key is configured. */
export function panelFingerprintSource(
  identity: (() => Promise<Parameters<typeof panelKeyFingerprints>[0] | null>) | undefined
): () => Promise<string[] | null> {
  return async () => {
    const loaded = identity ? await identity() : null
    return loaded ? panelKeyFingerprints(loaded) : null
  }
}

export type UpgradeRefusal = { status: 400 | 401 | 503; error: string }

export async function refuseUnsignedUpgrade(params: {
  header: string | null | undefined
  cnfJkt: string | undefined
  trustLevel: number
  key: { id: string; publicJwk: JsonWebKey }
  pathname: string
  panelFingerprints: () => Promise<string[] | null>
  /** Record the nonce as used until `expiresAt`; false when it was used before. */
  markNonceUsed: (nonce: string, expiresAt: Date) => Promise<boolean>
  nowMs: number
}): Promise<UpgradeRefusal | null> {
  if (!params.cnfJkt && params.trustLevel < DAEMON_PROOF_TRUST_LEVEL) return null
  if (params.cnfJkt && params.cnfJkt !== (await daemonKeyThumbprint(params.key.publicJwk))) {
    return { status: 401, error: 'unauthorized' }
  }
  const fingerprints = await params.panelFingerprints()
  if (!fingerprints) return { status: 503, error: 'Panel identity unavailable' }
  const verified = await verifyDaemonRequest({
    header: params.header,
    method: 'GET',
    pathname: params.pathname,
    body: new Uint8Array(0),
    keyId: params.key.id,
    publicJwk: params.key.publicJwk,
    panelFingerprints: fingerprints,
    nowMs: params.nowMs,
  })
  if (!verified.ok) return { status: verified.status, error: verified.error }
  const expiresAt = new Date((verified.value.iat + REQUEST_MAX_SKEW_SECONDS) * 1000)
  if (!(await params.markNonceUsed(verified.value.nonce, expiresAt))) {
    return { status: 401, error: 'Request replayed' }
  }
  return null
}

/**
 * {@link refuseUnsignedUpgrade} for one upgrade request on either runtime:
 * the header and path from the request, the nonce kept in the `nonce` table.
 */
export function refuseUnsignedDaemonUpgrade(params: {
  db: Db
  request: Request
  serverId: string
  cnfJkt: string | undefined
  state: { trustLevel?: number; key: { id: string; publicJwk: JsonWebKey } }
  panelIdentity: (() => Promise<PanelIdentity | null>) | undefined
}): Promise<UpgradeRefusal | null> {
  return refuseUnsignedUpgrade({
    header: params.request.headers.get(DAEMON_SIGNATURE_HEADER),
    cnfJkt: params.cnfJkt,
    trustLevel: params.state.trustLevel ?? 0,
    key: params.state.key,
    pathname: new URL(params.request.url).pathname,
    panelFingerprints: panelFingerprintSource(params.panelIdentity),
    markNonceUsed: (nonce, expiresAt) =>
      markRequestNonceUsed(params.db, params.serverId, nonce, expiresAt),
    nowMs: Date.now(),
  })
}
