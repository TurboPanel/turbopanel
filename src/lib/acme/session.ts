/**
 * What clients of one authority can safely share inside a process: the
 * directory (its addresses, which change rarely) and spare `Replay-Nonce`
 * values. Without this every step of an order built a new client that fetched
 * the directory and a nonce again, which doubled the calls an order makes and
 * hit the two endpoints with the tightest per-address limits.
 *
 * It is only a cache. A Workers isolate may start with it empty, may drop it at
 * any time, and serves many organizations, so nothing here is secret or tied to
 * an account: no keys, no account addresses, no clients. A stale nonce is
 * answered with `badNonce`, which the client already recovers from once, and
 * every pooled nonce expires after a few minutes anyway.
 *
 * Sessions are keyed by the `fetch` function in use, so a test with its own
 * fake authority never sees another test's cache; the real network (no
 * injected fetch) shares one session.
 */
import type { AcmeDirectory } from './client.ts'

/** The directory is looked at again after this long. */
export const DIRECTORY_TTL_MS = 3_600_000
/** A spare nonce older than this is dropped rather than risk a `badNonce`. */
export const NONCE_TTL_MS = 5 * 60_000
/** Spare nonces kept per authority; more are not needed and would only go stale. */
const MAX_SPARE_NONCES = 4

type Timed<T> = { value: T; at: number }

export class AcmeSession {
  readonly #directories = new Map<string, Timed<AcmeDirectory>>()
  readonly #nonces = new Map<string, Timed<string>[]>()

  directory(url: string, now: number = Date.now()): AcmeDirectory | null {
    const found = this.#directories.get(url)
    return found && now - found.at < DIRECTORY_TTL_MS ? found.value : null
  }

  rememberDirectory(url: string, directory: AcmeDirectory, now: number = Date.now()): void {
    this.#directories.set(url, { value: directory, at: now })
  }

  /** A spare nonce for this authority, or null when none is kept; each is handed out once. */
  takeNonce(url: string, now: number = Date.now()): string | null {
    const fresh = (this.#nonces.get(url) ?? []).filter((n) => now - n.at < NONCE_TTL_MS)
    const taken = fresh.pop()
    this.#nonces.set(url, fresh)
    return taken?.value ?? null
  }

  rememberNonce(url: string, nonce: string | null, now: number = Date.now()): void {
    if (!nonce) return
    const kept = (this.#nonces.get(url) ?? []).filter((n) => now - n.at < NONCE_TTL_MS)
    kept.push({ value: nonce, at: now })
    this.#nonces.set(url, kept.slice(-MAX_SPARE_NONCES))
  }
}

const sessions = new WeakMap<object, AcmeSession>()
/** Stands in for "the real network" as the key of the shared session. */
const NETWORK = {}

export function sessionFor(fetchFn: typeof fetch | undefined): AcmeSession {
  const key = fetchFn ?? NETWORK
  let session = sessions.get(key)
  if (!session) {
    session = new AcmeSession()
    sessions.set(key, session)
  }
  return session
}
