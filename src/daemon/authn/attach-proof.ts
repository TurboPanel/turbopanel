/**
 * The daemon's attach proof: in a signed session the daemon's presence
 * `hello` carries `attach: { keyId, iat, sig }`, where `sig` is its Ed25519
 * signature over
 *
 *   "tp-attach\n" + sessionId + "\n" + panelFingerprint + "\n" + serverId
 *     + "\n" + keyId + "\n" + iat
 *
 * `sessionId` and `panelFingerprint` are the ones in the control plane's
 * signed hello for this socket, so the proof cannot be lifted onto another
 * session or another control plane. Twin of `turbopaneld/src/crypto/keys.ts`;
 * the prefix is pinned in both contract-drift scripts.
 *
 * Workers-safe: WebCrypto only, nothing at module load.
 */
import { verifyDaemonSignature } from './server-key.ts'
import { REQUEST_MAX_SKEW_SECONDS } from './request-signature.ts'

export const ATTACH_PREFIX = 'tp-attach\n'

/** `server.trust_level` once a daemon proved itself with its own key (attach proof or signed request). */
export const DAEMON_PROOF_TRUST_LEVEL = 2

/** Close code and reason for a hello whose attach proof is missing or wrong. */
export const ATTACH_PROOF_CLOSE_CODE = 1008
export const ATTACH_PROOF_REFUSED_REASON = 'attach-proof-refused'
/**
 * Refusal reason for a hello with no proof from a server that already proved
 * itself: a downgrade, audited by both runtimes (`recordTrustDowngradeRefused`).
 */
export const ATTACH_PROOF_MISSING_REASON = 'attach proof missing'

export type AttachProofFields = { keyId: string; iat: number; sig: string }

export function attachSigningInput(params: {
  sessionId: string
  panelFingerprint: string
  serverId: string
  keyId: string
  iat: number
}): string {
  return [
    `${ATTACH_PREFIX}${params.sessionId}`,
    params.panelFingerprint,
    params.serverId,
    params.keyId,
    String(params.iat),
  ].join('\n')
}

function readAttach(value: unknown): AttachProofFields | null {
  if (typeof value !== 'object' || value === null) return null
  const { keyId, iat, sig } = value as Record<string, unknown>
  if (typeof keyId !== 'string' || keyId.length === 0 || keyId.length > 64) return null
  if (typeof iat !== 'number' || !Number.isInteger(iat) || iat < 0) return null
  if (typeof sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return null
  return { keyId, iat, sig }
}

/**
 * What to do with the first presence `hello` of a signed session.
 * - `verified`: the proof checks; raise the server to {@link DAEMON_PROOF_TRUST_LEVEL}.
 * - `absent`: no proof, from a daemon that predates it; carry on unless the
 *   server already proved itself before (then `refused`).
 * - `refused`: close the socket with {@link ATTACH_PROOF_CLOSE_CODE}.
 */
export type AttachDecision =
  { kind: 'verified' } | { kind: 'absent' } | { kind: 'refused'; reason: string }

export async function decideAttachProof(
  attach: unknown,
  ctx: {
    sessionId: string
    panelFingerprint: string
    serverId: string
    keyId: string | undefined
    publicJwk: JsonWebKey | undefined
    trustLevel: number
    nowMs: number
  }
): Promise<AttachDecision> {
  if (attach === undefined) {
    return ctx.trustLevel >= DAEMON_PROOF_TRUST_LEVEL
      ? { kind: 'refused', reason: ATTACH_PROOF_MISSING_REASON }
      : { kind: 'absent' }
  }
  const fields = readAttach(attach)
  if (!fields) return { kind: 'refused', reason: 'attach proof malformed' }
  if (!ctx.publicJwk || fields.keyId !== ctx.keyId) {
    return { kind: 'refused', reason: 'attach proof names another key' }
  }
  if (Math.abs(fields.iat - Math.floor(ctx.nowMs / 1000)) > REQUEST_MAX_SKEW_SECONDS) {
    return { kind: 'refused', reason: 'attach proof clock skew' }
  }
  const input = attachSigningInput({
    sessionId: ctx.sessionId,
    panelFingerprint: ctx.panelFingerprint,
    serverId: ctx.serverId,
    keyId: fields.keyId,
    iat: fields.iat,
  })
  return (await verifyDaemonSignature(ctx.publicJwk, input, fields.sig))
    ? { kind: 'verified' }
    : { kind: 'refused', reason: 'attach proof signature invalid' }
}

/** The public JWK of an Ed25519 key from its `x` (what the cell keeps on a socket). */
export function ed25519PublicJwk(x: string): JsonWebKey {
  return { kty: 'OKP', crv: 'Ed25519', x }
}
