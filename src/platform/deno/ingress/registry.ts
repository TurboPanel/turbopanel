import { isIngressMode, type IngressMode } from '../../../features/install/ingress-modes.ts'
import type { ApplyResult, IngressContext, IngressProvider, PreflightResult } from './provider.ts'
import { directProvider } from './providers/direct.ts'
import { lanOnlyProvider } from './providers/lan-only.ts'

const NOT_AVAILABLE = 'This connection mode is not available yet.'

const IMPLEMENTED: Partial<Record<IngressMode, IngressProvider>> = {
  direct: directProvider,
  'lan-only': lanOnlyProvider,
}

/** The provider for a mode, or undefined while the mode is not implemented. Throws on an unknown mode. */
export function ingressProviderFor(mode: string): IngressProvider | undefined {
  if (!isIngressMode(mode)) throw new TypeError(`Unknown ingress mode: ${mode}`)
  return IMPLEMENTED[mode]
}

export async function preflightHostname(ctx: IngressContext): Promise<PreflightResult> {
  const provider = ingressProviderFor(ctx.hostname.mode)
  if (provider) return await provider.preflight(ctx)
  return { ok: false, checks: [{ id: 'mode-available', ok: false, detail: NOT_AVAILABLE }] }
}

export async function applyHostname(ctx: IngressContext): Promise<ApplyResult> {
  const provider = ingressProviderFor(ctx.hostname.mode)
  if (!provider) {
    return { ok: false, cause: 'not-available', detail: NOT_AVAILABLE }
  }
  const preflight = await provider.preflight(ctx)
  if (!preflight.ok) {
    const failed = preflight.checks.find((item) => !item.ok)
    return { ok: false, cause: 'invalid-hostname', detail: failed?.detail ?? 'Preflight failed.' }
  }
  return await provider.apply(ctx)
}
