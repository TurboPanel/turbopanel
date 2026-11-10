/**
 * The control plane's side of the first frame on `/ws/daemon/v1`, shared by
 * the Deno socket and the Durable Object. Workers-safe: no Deno APIs, no I/O
 * of its own.
 *
 * The control plane sends nothing until the daemon's first frame arrives. A
 * `hello-nonce` starts a signed session: the answer is a `hello` signed by the
 * identity key, then every frame carries a signed envelope with `seq` 1, 2,
 * ... The hello always names the server and daemon key; envelopes do too when
 * the daemon offers `panel-bound-session-v1`. Any other first frame is an older (or unpinned) daemon: it gets today's
 * unsigned session, unless this server has already used a signed one
 * (`server.trust_level` 1 or more), which closes the socket with 4403.
 */
import { parseHelloNonceFrame } from '../contracts/cell-protocol.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'
import {
  envelopeFrame,
  newSignedSession,
  type SignedSessionBinding,
  type SignedSessionState,
} from '../lib/panel-identity/signed-session.ts'

/** Close code for a session the control plane will not run (no key, or unsigned after signed). */
export const PANEL_IDENTITY_CLOSE_CODE = 4403
export const SIGNED_MODE_REQUIRED_REASON = 'signed-mode-required'
export const PANEL_IDENTITY_UNAVAILABLE_REASON = 'panel-identity-unavailable'
export const SESSION_BINDING_UNAVAILABLE_REASON = 'session-binding-unavailable'
export const SIGNED_SEND_FAILED_REASON = 'signed-send-failed'

export type DaemonSessionPhase = 'await-first-frame' | 'legacy' | 'signed'

export type FirstFrameDecision =
  | { kind: 'signed'; identity: PanelIdentity; session: SignedSessionState; nonce: string }
  | { kind: 'legacy' }
  | { kind: 'refused'; reason: string }

/** What the first daemon frame on a socket starts. Reads the identity only for a `hello-nonce`. */
export async function decideFirstFrame(
  raw: string,
  ctx: {
    trustLevel: number
    panelIdentity?: () => Promise<PanelIdentity | null>
    /** The server and daemon key the socket's token named; the hello always signs them. */
    binding?: SignedSessionBinding
  }
): Promise<FirstFrameDecision> {
  const nonceFrame = parseHelloNonceFrame(raw)
  if (nonceFrame) {
    const identity = ctx.panelIdentity ? await ctx.panelIdentity() : null
    if (!identity) return { kind: 'refused', reason: PANEL_IDENTITY_UNAVAILABLE_REASON }
    // The hello always names the server and key, offer or not: every frame carries the hello's
    // random session id, so a session whose hello names one server never verifies on another.
    if (!ctx.binding?.serverId || !ctx.binding.keyId) {
      return { kind: 'refused', reason: SESSION_BINDING_UNAVAILABLE_REASON }
    }
    return {
      kind: 'signed',
      identity,
      session: newSignedSession(
        identity.current.kid,
        nonceFrame.bound ? ctx.binding : undefined,
        ctx.binding
      ),
      nonce: nonceFrame.nonce,
    }
  }
  if (ctx.trustLevel >= 1) return { kind: 'refused', reason: SIGNED_MODE_REQUIRED_REASON }
  return { kind: 'legacy' }
}

/**
 * One socket's sender for the process that holds it (Deno). Sends run one at
 * a time in call order, so `seq` follows the order frames hit the wire. In a
 * signed session a send that fails after its `seq` was taken calls
 * `onSignedSendFailure` (close the socket): no later frame may follow a gap.
 */
export function createDaemonSessionSender(opts: {
  sendText: (text: string) => void
  onSignedSendFailure: (err: unknown) => void
  now?: () => number
}) {
  let signed: { identity: PanelIdentity; session: SignedSessionState } | undefined
  let chain: Promise<void> = Promise.resolve()
  const now = opts.now ?? Date.now

  async function sendNow(wire: { type: string }): Promise<void> {
    if (!signed) {
      opts.sendText(JSON.stringify(wire))
      return
    }
    const seq = signed.session.nextSeq
    signed.session.nextSeq = seq + 1
    try {
      opts.sendText(await envelopeFrame(signed.identity, signed.session, wire, seq, now()))
    } catch (err) {
      opts.onSignedSendFailure(err)
      throw err
    }
  }

  return {
    /** Every later {@link send} is enveloped and signed. */
    enterSigned(identity: PanelIdentity, session: SignedSessionState): void {
      signed = { identity, session }
    },
    send(wire: { type: string }): Promise<void> {
      const run = chain.then(() => sendNow(wire))
      chain = run.catch(() => undefined)
      return run
    },
  }
}

export type DaemonSessionSender = ReturnType<typeof createDaemonSessionSender>
