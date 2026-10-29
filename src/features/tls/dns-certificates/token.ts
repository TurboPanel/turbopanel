/**
 * The ONE place a DNS-validated certificate picks the provider token it uses.
 * It asks the shared token selector for an active token on the account that can
 * edit DNS for the zone (matched by zone id), so renewal and cleanup never
 * depend on one particular token. To look a zone up before it is known, any
 * token that reaches some DNS zone will do.
 */
import { listBadges, toApiBadge } from '../../tunnels/records.ts'
import { openBestBadge } from '../../tunnels/badge-use.ts'
import type { DnsCertContext } from './context.ts'

export type DnsTokenNeed = { zone: { id: string; name?: string } } | 'any'

/** The plain token text, or null when no active token on the account fits. */
export async function openDnsToken(
  ctx: Pick<DnsCertContext, 'db' | 'secrets'>,
  carrierId: string,
  need: DnsTokenNeed
): Promise<string | null> {
  const zone = need === 'any' ? await anyDnsZone(ctx, carrierId) : need.zone
  if (!zone) return null
  const opened = await openBestBadge(ctx.db, ctx.secrets, carrierId, { capability: 'dns', zone })
  return opened?.token ?? null
}

/** A zone some active token on the account reaches, to find the token that can look zones up. */
async function anyDnsZone(
  ctx: Pick<DnsCertContext, 'db'>,
  carrierId: string
): Promise<{ id: string; name: string } | null> {
  for (const row of await listBadges(ctx.db, carrierId)) {
    if (row.status !== 'active') continue
    const zone = toApiBadge(row).capabilities.dns[0]
    if (zone) return zone
  }
  return null
}
