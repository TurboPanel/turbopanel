import {
  type IdentityChainState,
  IDENTITY_DOCUMENT_RESIGN_AFTER_MS,
  signIdentityDocument,
  type SignedIdentityResponse,
} from './document.ts'
import type { PanelIdentity } from './identity.ts'

type Entry = {
  response: SignedIdentityResponse
  kid: string
  keyset: number
  nextKid: string | null
  urlsKey: string
  chainKey: string
}

/**
 * Keeps the signed document between requests and re-signs it when it is a
 * week old, the URL list changed, or the key set or rotation passkeys changed. Holds only the
 * signed bytes (no database client), so an isolate-scope instance is safe on
 * Workers.
 */
export function createIdentityDocumentCache(now: () => Date = () => new Date()) {
  let entry: Entry | null = null
  return {
    async get(
      identity: PanelIdentity,
      urls: string[],
      chain?: IdentityChainState
    ): Promise<SignedIdentityResponse> {
      const urlsKey = JSON.stringify(urls)
      const chainKey = JSON.stringify(chain ?? null)
      const at = now()
      const stale =
        entry?.kid !== identity.current.kid ||
        entry?.keyset !== identity.keyset ||
        entry?.nextKid !== (identity.next?.kid ?? null) ||
        entry?.urlsKey !== urlsKey ||
        entry?.chainKey !== chainKey ||
        at.getTime() - Date.parse(entry.response.issued) > IDENTITY_DOCUMENT_RESIGN_AFTER_MS
      if (stale) {
        entry = {
          response: await signIdentityDocument(identity, urls, at, chain),
          kid: identity.current.kid,
          keyset: identity.keyset,
          nextKid: identity.next?.kid ?? null,
          urlsKey,
          chainKey,
        }
      }
      return entry!.response
    },
  }
}

/** How long the public identity routes reuse what they read from the key-set chain. */
export const IDENTITY_CHAIN_CACHE_MS = 30_000
/** Statement pages kept per cache: one per `after` value servers ask with. */
export const IDENTITY_CHAIN_PAGE_LIMIT = 8

/**
 * Keeps the chain facts the public identity routes serve (the live key set,
 * the marked passkeys, and whole statement pages) for a short while, so
 * anonymous requests do not reach the database every time. Holds data only,
 * never a database client, so an isolate-scope instance is safe on Workers.
 *
 * Entries belong to one loaded key and identity key set: when the key changes
 * (a rotation, or a new High Availability secret) the first request misses,
 * which is what turns a waiting statement live.
 */
export function createIdentityChainCache(
  now: () => number = Date.now,
  ttlMs: number = IDENTITY_CHAIN_CACHE_MS
) {
  let owner = ''
  let state: { at: number; value: IdentityChainState } | null = null
  const pages = new Map<number, { at: number; body: string }>()
  const fresh = (at: number) => now() - at < ttlMs
  const claim = (identity: PanelIdentity) => {
    const key = `${identity.current.kid}:${identity.keyset}`
    if (key === owner) return
    owner = key
    state = null
    pages.clear()
  }
  return {
    /** The chain state, read with `load` at most once per `ttlMs`. */
    async state(
      identity: PanelIdentity,
      load: () => Promise<IdentityChainState>
    ): Promise<IdentityChainState> {
      claim(identity)
      if (state && fresh(state.at)) return state.value
      const value = await load()
      claim(identity)
      state = { at: now(), value }
      return value
    },
    /** The serialized statements above `after`, when a fresh copy is held. */
    page(identity: PanelIdentity, after: number): string | null {
      claim(identity)
      const held = pages.get(after)
      if (held && fresh(held.at)) return held.body
      pages.delete(after)
      return null
    },
    keepPage(identity: PanelIdentity, after: number, body: string): void {
      claim(identity)
      if (!pages.has(after) && pages.size >= IDENTITY_CHAIN_PAGE_LIMIT) {
        const oldest = pages.keys().next()
        if (!oldest.done) pages.delete(oldest.value)
      }
      pages.set(after, { at: now(), body })
    },
  }
}
