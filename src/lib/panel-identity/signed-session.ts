import { base64urlEncode } from '../encoding/base64url.ts'
import { appendSignature, frameSigningInput, helloSigningInput } from './frame-envelope.ts'
import { signWithCurrent, type PanelIdentity } from './identity.ts'

/**
 * One signed daemon session: the control plane proves itself with a signed
 * `hello` that echoes the daemon's nonce, then wraps every later frame in an
 * envelope `{sessionId, seq, iat, kid}` plus `sig`. `seq` starts at 1 and the
 * daemon refuses anything but last+1. The hello always carries `forServer`
 * and `forKey` (the server id and daemon key id the socket authenticated as),
 * and every frame carries the hello's random session id, so a session signed
 * for one server never verifies on another. When the daemon offered
 * `panel-bound-session-v1`, every frame names the two as well (an older daemon
 * would pass extra frame members on, so they are not sent unasked). Workers-safe: no I/O, no Deno APIs.
 */
export type SignedSessionBinding = { serverId: string; keyId: string }
export type SignedSessionState = {
  sessionId: string
  nextSeq: number
  kid: string
  /** Set when the daemon offered `panel-bound-session-v1`: every frame names these. */
  bind?: SignedSessionBinding
  /** The hello's binding: set for every signed session, offer or not (falls back to `bind`). */
  helloBind?: SignedSessionBinding
}

/** Envelope members every signed frame carries; no wire message may use these names. */
export const SIGNED_ENVELOPE_FIELDS = [
  'sessionId',
  'seq',
  'iat',
  'kid',
  'forServer',
  'forKey',
  'sig',
] as const

export function newSignedSession(
  kid: string,
  bind?: SignedSessionBinding,
  helloBind?: SignedSessionBinding
): SignedSessionState {
  return {
    sessionId: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    nextSeq: 1,
    kid,
    ...(bind ? { bind } : {}),
    ...(helloBind ? { helloBind } : {}),
  }
}

/** The signed members that tie a hello or frame to one server and daemon key (none when unbound). */
function bindingMembers(bind: SignedSessionBinding | undefined): Record<string, string> {
  return bind ? { forServer: bind.serverId, forKey: bind.keyId } : {}
}

function unixSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000)
}

/** The signed `hello` text, answering the daemon's `hello-nonce`. */
export async function buildSignedHello(
  identity: PanelIdentity,
  nonce: string,
  session: Pick<SignedSessionState, 'sessionId' | 'bind' | 'helloBind'>,
  opts: { heartbeatSeconds: number; urls: string[]; nowMs?: number }
): Promise<string> {
  const unsigned = JSON.stringify({
    type: 'hello',
    nonce,
    sessionId: session.sessionId,
    kid: identity.current.kid,
    ...bindingMembers(session.helloBind ?? session.bind),
    keyset: identity.keyset,
    heartbeatSeconds: opts.heartbeatSeconds,
    urls: opts.urls,
    iat: unixSeconds(opts.nowMs ?? Date.now()),
  })
  return appendSignature(unsigned, await signWithCurrent(identity, helloSigningInput(unsigned)))
}

/** `wire` with the envelope appended and signed; `session` is not changed (the caller owns `seq`). */
export async function envelopeFrame(
  identity: PanelIdentity,
  session: Pick<SignedSessionState, 'sessionId' | 'bind'>,
  wire: { type: string },
  seq: number,
  nowMs: number = Date.now()
): Promise<string> {
  const record = wire as Record<string, unknown>
  for (const field of SIGNED_ENVELOPE_FIELDS) {
    if (field in record) {
      throw new TypeError(`wire message ${wire.type} already has envelope member ${field}`)
    }
  }
  const unsigned = JSON.stringify({
    ...record,
    sessionId: session.sessionId,
    seq,
    iat: unixSeconds(nowMs),
    kid: identity.current.kid,
    ...bindingMembers(session.bind),
  })
  return appendSignature(
    unsigned,
    await signWithCurrent(identity, frameSigningInput(wire.type, unsigned))
  )
}
