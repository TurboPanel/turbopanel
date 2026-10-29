import type { CarrierRow } from '../../tunnels/records.ts'
import type { TunnelProvider } from '../../tunnels/vocabulary.ts'
import type { DnsCertContext } from './context.ts'
import { baseName } from './names.ts'
import { openDnsToken } from './token.ts'
import type { ZoneRef } from './order-state.ts'

export class NoDnsTokenError extends Error {
  constructor() {
    super('No token on this account can edit DNS records')
    this.name = 'NoDnsTokenError'
  }
}

/**
 * The zone each name lives in, among the zones the account's tokens can edit.
 * Throws {@link NoDnsTokenError} when no token on the account reaches any DNS
 * zone, and the provider's `zone_not_found` error for a name no zone holds.
 */
export async function resolveZones(
  ctx: DnsCertContext,
  carrier: CarrierRow,
  names: readonly string[]
): Promise<ZoneRef[]> {
  const token = await openDnsToken(ctx, carrier.id, 'any')
  if (!token) throw new NoDnsTokenError()
  const adapter = ctx.adapters(carrier.provider as TunnelProvider)
  const bases = [...new Set(names.map(baseName))]
  const zones = await Promise.all(
    bases.map((hostname) =>
      adapter.findZone(token, { accountId: carrier.externalAccountId, hostname })
    )
  )
  const seen = new Map<string, ZoneRef>()
  for (const zone of zones) seen.set(zone.id, { id: zone.id, name: zone.name })
  return [...seen.values()]
}
