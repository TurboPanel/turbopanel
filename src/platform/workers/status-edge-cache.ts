import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'

/** The slice of the Workers Cache API this module uses (injectable in tests). */
export type EdgeCacheLike = {
  match(key: Request): Promise<Response | undefined>
  put(key: Request, response: Response): Promise<void>
}

const STATUS_PATH = `${CLIENT_API_PREFIX}/status`

/**
 * Cache key for the public status response, or null when the request must go
 * to the app. Keyed on origin + path only (query string, cookies and other
 * headers never reach the key). Only a plain GET without an `Origin` header
 * qualifies: a cross-origin read carries CORS headers that vary by origin, so
 * it is answered by the app (the browser still caches it via Cache-Control).
 */
export function statusEdgeCacheKey(request: Request): Request | null {
  if (request.method !== 'GET' || request.headers.has('Origin')) return null
  const url = new URL(request.url)
  if (url.pathname !== STATUS_PATH) return null
  return new Request(`${url.origin}${STATUS_PATH}`, { method: 'GET' })
}

/** Whether a finished response may be stored: a cacheable 200 that sets no cookie. */
export function isEdgeCacheableStatusResponse(response: Response): boolean {
  if (response.status !== 200 || response.headers.has('Set-Cookie')) return false
  const cacheControl = response.headers.get('Cache-Control') ?? ''
  return cacheControl.startsWith('public,')
}

/** Copy of the response without per-request timing, ready for the cache. */
export function toEdgeCacheEntry(response: Response): Response {
  const copy = new Response(response.clone().body, response)
  copy.headers.delete('Server-Timing')
  return copy
}
