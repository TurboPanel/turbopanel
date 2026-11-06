import type { MiddlewareHandler } from 'hono'
import { IDENTITY_SIGNATURE_HEADER } from './document.ts'
import { httpSigningInput } from './frame-envelope.ts'
import { signWithCurrent, type PanelIdentity } from './identity.ts'

/**
 * Daemon API responses a daemon acts on. Every answer on these paths, error
 * bodies included, carries `X-TurboPanel-Signature: <kid>:<sig>` over
 * `"tp-http\n" + pathname + "\n" + body` when the identity key is configured,
 * so a pinned daemon never changes state (for example drops its key on a
 * "server key not found") on an answer it cannot verify. The daemon keeps
 * the same list (`SIGNED_RESPONSE_ROUTES`). The identity document signs itself.
 */
export const SIGNED_DAEMON_RESPONSE_PATHS: ReadonlySet<string> = new Set([
  '/api/daemon/v1/instance/ca',
  '/api/daemon/v1/instance/uploaded-trust',
  '/api/daemon/v1/jwks.json',
  '/api/daemon/v1/ping',
  '/api/daemon/v1/deployments/secrets/rehydrate',
  '/api/daemon/v1/host/docker-networking',
  '/api/daemon/v1/secrets/decrypt',
  '/api/daemon/v1/auth/challenge',
  '/api/daemon/v1/auth/session',
  '/api/daemon/v1/enroll',
])

/** The header value for `body` served at `pathname` (no query, no host). */
export async function signHttpBody(
  identity: PanelIdentity,
  pathname: string,
  body: string
): Promise<string> {
  const sig = await signWithCurrent(identity, httpSigningInput(pathname, body))
  return `${identity.current.kid}:${sig}`
}

/**
 * Signs the finished response for a path in {@link SIGNED_DAEMON_RESPONSE_PATHS}.
 * No identity (feature off) leaves the response exactly as it was.
 */
export function signDaemonResponses(
  panelIdentity: (() => Promise<PanelIdentity | null>) | undefined
): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (!panelIdentity) return
    const pathname = new URL(c.req.url).pathname
    if (!SIGNED_DAEMON_RESPONSE_PATHS.has(pathname)) return
    if (c.res.headers.has(IDENTITY_SIGNATURE_HEADER)) return
    const identity = await panelIdentity()
    if (!identity) return
    const original = c.res
    const body = await original.text()
    const headers = new Headers(original.headers)
    headers.set(IDENTITY_SIGNATURE_HEADER, await signHttpBody(identity, pathname, body))
    c.res = undefined
    c.res = new Response(body, {
      status: original.status,
      statusText: original.statusText,
      headers,
    })
  }
}
