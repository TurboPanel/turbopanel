/**
 * Where a challenge record goes: the zone of a name among the zones the
 * organization's DNS tokens can edit, and, when the challenge name is a CNAME,
 * the place it points at (a TXT record cannot sit beside a CNAME). Reached
 * through the DNS provider only; nothing here talks to the certificate
 * authority.
 */
import { TunnelProviderError } from '../../tunnels/errors.ts'
import { type CarrierRow, listCarriers } from '../../tunnels/records.ts'
import type { TunnelAdapterRegistry } from '../../tunnels/registry.ts'
import type { TunnelProvider } from '../../tunnels/vocabulary.ts'
import { ChallengeTargetError } from './dns-provider.ts'
import type { ZoneRef } from './order-state.ts'
import { type RecordsContext, dnsFor } from './records.ts'
import { withAnyDnsToken } from './token.ts'

/** A CNAME chain longer than this is treated as a loop. */
const MAX_CNAME_HOPS = 5

export type ZoneContext = RecordsContext & { adapters: TunnelAdapterRegistry }

/** The zone of `name` among `zones` (the longest match), or undefined. */
export function zoneFor(zones: readonly ZoneRef[], name: string): ZoneRef | undefined {
  return zones
    .filter((z) => name === z.name || name.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0]
}

/** The zone of `name` on one carrier's account, or null when no token there reaches one. */
export async function findZoneOnCarrier(
  ctx: ZoneContext,
  carrier: CarrierRow,
  name: string
): Promise<ZoneRef | null> {
  try {
    const found = await withAnyDnsToken(ctx, carrier.id, (token) =>
      ctx.adapters(carrier.provider as TunnelProvider).findZone(token, {
        accountId: carrier.externalAccountId,
        hostname: name,
      })
    )
    return found ? { id: found.value.id, name: found.value.name } : null
  } catch (err) {
    if (err instanceof TunnelProviderError && err.code === 'zone_not_found') return null
    throw err
  }
}

/** The first carrier of the organization whose tokens reach a zone for `name`. */
export async function findZoneInOrganization(
  ctx: ZoneContext,
  organizationId: string,
  name: string
): Promise<{ carrier: CarrierRow; zone: ZoneRef } | null> {
  for (const { carrier } of await listCarriers(ctx.db, organizationId)) {
    const zone = await findZoneOnCarrier(ctx, carrier, name)
    if (zone) return { carrier, zone }
  }
  return null
}

/**
 * Where the record for `at.name` has to be written: the name itself, or the end
 * of its CNAME chain. When the target's zone cannot be edited with this account
 * the call throws, saying so, and nothing was changed.
 */
export async function writeTarget(
  ctx: ZoneContext,
  organizationId: string,
  carrier: CarrierRow,
  at: { name: string; zoneId: string },
  depth = 0
): Promise<{ name: string; zoneId: string }> {
  const dns = await dnsFor(ctx, { organizationId }, { carrierId: carrier.id }, at.zoneId)
  const target = await dns.lookupCname({ zoneId: at.zoneId, name: at.name })
  if (target === null) return at
  if (depth >= MAX_CNAME_HOPS) {
    throw new ChallengeTargetError(
      at.name,
      target,
      'The aliases point at each other or are too long.'
    )
  }
  const zone = await findZoneOnCarrier(ctx, carrier, target)
  if (!zone) {
    throw new ChallengeTargetError(at.name, target, 'This account has no zone for that name.')
  }
  return await writeTarget(
    ctx,
    organizationId,
    carrier,
    { name: target, zoneId: zone.id },
    depth + 1
  )
}
