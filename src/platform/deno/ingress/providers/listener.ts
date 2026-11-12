import type { IngressMode } from '../../../../features/install/ingress-modes.ts'
import { capabilitiesFor } from '../capabilities.ts'
import { planHostname } from '../planner.ts'
import type {
  ApplyResult,
  IngressCapabilities,
  IngressContext,
  IngressProvider,
  IngressStatus,
  PreflightResult,
} from '../provider.ts'

/**
 * A provider for modes where visitors reach the panel's own listener: nothing
 * to configure on apply, so only the checks and the status facts differ.
 */
export function createListenerProvider(
  mode: IngressMode,
  facts: Record<string, string | number | boolean>
): IngressProvider {
  const capabilities: IngressCapabilities = capabilitiesFor(mode)
  return {
    mode,
    capabilities,
    preflight: (ctx: IngressContext): Promise<PreflightResult> =>
      Promise.resolve(planHostname(ctx.hostname, true)),
    apply: (): Promise<ApplyResult> => Promise.resolve({ ok: true, state: {} }),
    status: (): Promise<IngressStatus> => Promise.resolve({ phase: 'healthy', facts }),
    remove: (): Promise<void> => Promise.resolve(),
  }
}
