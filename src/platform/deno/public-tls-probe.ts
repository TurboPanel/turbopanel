/**
 * The self-hosted control plane's public-trust check for an uploaded
 * hostname: a TLS handshake against its own listener on loopback, with the
 * hostname as SNI. Deno's verifier decides whether the chain the listener
 * serves for that name reaches a public root and covers the name. Nothing is
 * written to disk, no process is started, and no request is sent: the
 * connection closes as soon as the handshake ends.
 */

import type { PublicTlsAnswer, PublicTlsProbe } from '../../features/install/install-trust.ts'

type Closable = { close: () => void }
type TlsClosable = Closable & { handshake: () => Promise<unknown> }

export type PublicTlsProbeDeps = {
  connect: (options: { hostname: string; port: number; transport: 'tcp' }) => Promise<Closable>
  startTls: (conn: Closable, options: { hostname: string }) => Promise<TlsClosable>
  /** Where the listener is dialed. The certificate is chosen by SNI, not by this. */
  listenerAddress: string
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 5_000

function closeQuietly(conn: Closable | null): void {
  try {
    conn?.close()
  } catch {
    // Already closed: nothing to release.
  }
}

/**
 * A refused certificate (unknown issuer, wrong name, expired) is `private`.
 * Anything else, such as a reset or an unexpected record, says nothing about
 * the certificate and is `unavailable`.
 */
function answerFromHandshakeError(err: unknown): PublicTlsAnswer {
  const message = err instanceof Error ? err.message : String(err)
  return /certificate|UnknownIssuer|NotValidForName|Expired|BadSignature/i.test(message)
    ? 'private'
    : 'unavailable'
}

/** Connections one probe opened, and whether the probe already answered. */
type Attempt = { opened: Closable[]; settled: boolean }

/** Keeps `conn` for closing, or closes it at once when the probe already answered. */
function track(attempt: Attempt, conn: Closable): boolean {
  if (attempt.settled) {
    closeQuietly(conn)
    return false
  }
  attempt.opened.push(conn)
  return true
}

async function handshake(
  deps: PublicTlsProbeDeps,
  hostname: string,
  port: number,
  attempt: Attempt
): Promise<PublicTlsAnswer> {
  let tcp: Closable
  try {
    tcp = await deps.connect({ hostname: deps.listenerAddress, port, transport: 'tcp' })
  } catch {
    return 'unavailable'
  }
  if (!track(attempt, tcp)) return 'unavailable'
  try {
    const tls = await deps.startTls(tcp, { hostname })
    if (!track(attempt, tls)) return 'unavailable'
    await tls.handshake()
    return 'public'
  } catch (err) {
    return answerFromHandshakeError(err)
  }
}

export function createPublicTlsProbe(deps: Partial<PublicTlsProbeDeps> = {}): PublicTlsProbe {
  const resolved: PublicTlsProbeDeps = {
    connect: deps.connect ?? ((options) => Deno.connect(options)),
    startTls: deps.startTls ?? ((conn, options) => Deno.startTls(conn as Deno.TcpConn, options)),
    listenerAddress: deps.listenerAddress ?? '127.0.0.1',
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  return async (hostname, port) => {
    const attempt: Attempt = { opened: [], settled: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<PublicTlsAnswer>((resolve) => {
      timer = setTimeout(() => resolve('unavailable'), resolved.timeoutMs)
    })
    try {
      return await Promise.race([handshake(resolved, hostname, port, attempt), timedOut])
    } finally {
      clearTimeout(timer)
      attempt.settled = true
      // The TLS connection owns the TCP one once it exists; closing both is harmless.
      for (const conn of attempt.opened.toReversed()) closeQuietly(conn)
    }
  }
}
