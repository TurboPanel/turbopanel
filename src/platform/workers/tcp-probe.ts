/**
 * The hosted control plane's side of the outside reachability check, built on
 * Cloudflare Workers' TCP sockets (`connect` from `cloudflare:sockets`).
 *
 * The `connect` function is passed in by the Worker entry (`src/workers.ts`),
 * which is the only place `cloudflare:sockets` is imported: this module stays
 * importable by Deno tests and type checks.
 *
 * What a Worker cannot do, per Cloudflare's documentation: connect on port 25,
 * to Cloudflare's own IP ranges, or to localhost and private network
 * addresses. `canReachPrivate` is therefore false (the plan skips private
 * addresses instead of dialling them), and a refusal by the platform comes back
 * as `blocked`. The `opened` promise is the only success signal; the error text
 * is the only failure signal, so refused/blocked are best-effort labels: only
 * `open` ever decides anything.
 */

import type { TcpProbe, TcpProbeResult, TcpProbeTarget } from '../ports/tcp-probe.ts'

type SocketLike = {
  opened: Promise<unknown>
  close: () => Promise<void> | void
}

export type WorkersSocketConnect = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen: boolean }
) => SocketLike

const REFUSED_RE = /refused|reset/i
const BLOCKED_RE = /cloudflare|not allowed|disallowed|blocked|private|localhost|loopback|port 25/i

export function stateFromWorkersError(err: unknown): TcpProbeResult['state'] {
  const text = err instanceof Error ? err.message : String(err)
  if (BLOCKED_RE.test(text)) return 'blocked'
  return REFUSED_RE.test(text) ? 'refused' : 'error'
}

function closeQuietly(socket: SocketLike): void {
  try {
    void Promise.resolve(socket.close()).catch(() => undefined)
  } catch {
    // Nothing left to release.
  }
}

function openOutcome(socket: SocketLike, started: number): Promise<TcpProbeResult> {
  return socket.opened.then(
    (): TcpProbeResult => ({ state: 'open', ms: Date.now() - started }),
    (err: unknown): TcpProbeResult => ({ state: stateFromWorkersError(err), ms: null })
  )
}

export function createWorkersTcpProbe(connect: WorkersSocketConnect): TcpProbe {
  return {
    canReachPrivate: false,
    connect: (target: TcpProbeTarget, timeoutMs: number) => {
      const started = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      let socket: SocketLike | undefined
      try {
        socket = connect(
          { hostname: target.address, port: target.port },
          { secureTransport: 'off', allowHalfOpen: false }
        )
      } catch (err) {
        return Promise.resolve({ state: stateFromWorkersError(err), ms: null })
      }
      const opened = socket
      const timedOut = new Promise<TcpProbeResult>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'timeout', ms: null }), timeoutMs)
      })
      return Promise.race([openOutcome(opened, started), timedOut]).finally(() => {
        clearTimeout(timer)
        closeQuietly(opened)
      })
    },
  }
}
