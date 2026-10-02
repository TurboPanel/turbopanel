/**
 * Race `work` against `signal`: rejects with the abort reason the moment the
 * signal fires, even when `work` itself never notices it (a TLS handshake to
 * a peer that never answers, a resolver that ignores the signal). Whatever
 * `work` produces after that is handed to `disposeLate` — a connection that
 * finishes opening after the deadline is closed, not leaked — and a late
 * rejection is swallowed.
 */
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  disposeLate: (late: T) => void = () => {}
): Promise<T> {
  if (!signal) return work
  const discard = () => {
    work.then(
      (late) => {
        try {
          disposeLate(late)
        } catch {
          // already gone; nothing else to release
        }
      },
      () => {}
    )
  }
  if (signal.aborted) {
    discard()
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      discard()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
