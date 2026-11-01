import {
  IDENTITY_DOCUMENT_RESIGN_AFTER_MS,
  signIdentityDocument,
  type SignedIdentityResponse,
} from './document.ts'
import type { PanelIdentity } from './identity.ts'

type Entry = { response: SignedIdentityResponse; kid: string; keyset: number; urlsKey: string }

/**
 * Keeps the signed document between requests and re-signs it when it is a
 * week old, the URL list changed, or the key set changed. Holds only the
 * signed bytes (no database client), so an isolate-scope instance is safe on
 * Workers.
 */
export function createIdentityDocumentCache(now: () => Date = () => new Date()) {
  let entry: Entry | null = null
  return {
    async get(identity: PanelIdentity, urls: string[]): Promise<SignedIdentityResponse> {
      const urlsKey = JSON.stringify(urls)
      const at = now()
      const stale =
        entry?.kid !== identity.current.kid ||
        entry?.keyset !== identity.keyset ||
        entry?.urlsKey !== urlsKey ||
        at.getTime() - Date.parse(entry.response.issued) > IDENTITY_DOCUMENT_RESIGN_AFTER_MS
      if (stale) {
        entry = {
          response: await signIdentityDocument(identity, urls, at),
          kid: identity.current.kid,
          keyset: identity.keyset,
          urlsKey,
        }
      }
      return entry!.response
    },
  }
}
