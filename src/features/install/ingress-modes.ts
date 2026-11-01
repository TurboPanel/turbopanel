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

export function isIngressMode(value: unknown): value is IngressMode {
  return typeof value === 'string' && (INGRESS_MODES as readonly string[]).includes(value)
}

/** An integer TCP port, 1 to 65535. */
export function isPublicPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}
