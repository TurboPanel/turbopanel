/**
 * Vocabulary for how visitors reach a control-plane hostname. Pure and
 * Workers-safe: no I/O, no ACME or provider tokens. The `origin.mode` CHECK
 * and the `ingress.provider` CHECK are pinned to these lists by
 * `src/db/enum-checks.test.ts`.
 */

export const INGRESS_MODES = [
  'direct',
  'lan-only',
  'cloudflare-tunnel',
  'cloudflare-proxy',
  'bunny-proxy',
  'private-overlay',
  'passthrough',
] as const

export type IngressMode = (typeof INGRESS_MODES)[number]

export const INGRESS_PROVIDERS = ['cloudflare', 'bunny'] as const

export type IngressProviderId = (typeof INGRESS_PROVIDERS)[number]

/** The port the control plane listens on, and what a hostname publishes until told otherwise. */
export const DEFAULT_PUBLIC_PORT = 8443

/** Shown when a self-hosted control plane is asked for any other public port. */
export const SELF_HOSTED_PUBLIC_PORT_ERROR =
  "The control plane's address always uses port 8443 when self-hosted."

let selfHostedAddress = false

/**
 * Called once by the self-hosted (Deno) server at start-up. From then on the
 * control plane's address is always {@link DEFAULT_PUBLIC_PORT}, even behind a
 * tunnel that also answers on 443. The Workers runtime never calls it, so
 * High Availability keeps its stored per-name port.
 */
export function setSelfHostedAddress(on: boolean): void {
  selfHostedAddress = on
}

/** The one public port a self-hosted control plane uses, or `null` on Workers. */
export function fixedPublicPort(): number | null {
  return selfHostedAddress ? DEFAULT_PUBLIC_PORT : null
}

/** True when the port may be stored: any valid port on Workers, only 8443 when self-hosted. */
export function isAllowedPublicPort(value: unknown): value is number {
  if (!isPublicPort(value)) return false
  const fixed = fixedPublicPort()
  return fixed === null || value === fixed
}

export function isIngressMode(value: unknown): value is IngressMode {
  return typeof value === 'string' && (INGRESS_MODES as readonly string[]).includes(value)
}

/** An integer TCP port, 1 to 65535. */
export function isPublicPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}
