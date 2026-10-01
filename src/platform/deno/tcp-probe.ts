/**
 * The self-hosted control plane's side of the outside reachability check:
 * a bounded TCP handshake with `Deno.connect`. The connection is closed the
 * moment it opens; nothing is ever written or read.
 */

import type { TcpProbe, TcpProbeResult, TcpProbeTarget } from '../ports/tcp-probe.ts'

type DenoConnect = (options: {
  hostname: string
  port: number
  transport: 'tcp'
}) => Promise<{ close: () => void }>

function stateFromError(err: unknown): TcpProbeResult['state'] {
  if (err instanceof Deno.errors.ConnectionRefused || err instanceof Deno.errors.ConnectionReset) {
    return 'refused'
  }
  return err instanceof Deno.errors.TimedOut ? 'timeout' : 'error'
}

function closeQuietly(conn: { close: () => void }): void {
  try {
    conn.close()
  } catch {
    // Already closed: nothing to release.
  }
}

/** Resolves with the connection attempt's outcome, or `timeout` when `timeoutMs` passes first. */
export function createDenoTcpProbe(connect: DenoConnect = Deno.connect): TcpProbe {
  return {
    canReachPrivate: true,
    connect: (target: TcpProbeTarget, timeoutMs: number) => {
      const started = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<TcpProbeResult>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'timeout', ms: null }), timeoutMs)
      })
      const attempt = connect({
        hostname: target.address,
        port: target.port,
        transport: 'tcp',
      }).then(
        (conn): TcpProbeResult => {
          closeQuietly(conn)
          return { state: 'open', ms: Date.now() - started }
        },
        (err: unknown): TcpProbeResult => ({ state: stateFromError(err), ms: null })
      )
      return Promise.race([attempt, timedOut]).finally(() => clearTimeout(timer))
    },
  }
}
