/**
 * The ONE place a DNS-validated certificate picks the provider token it uses:
 * an active token on the account that can edit DNS for the given zone (or, to
 * look a zone up, any DNS token). Any such token will do, so renewal and
 * cleanup never depend on one particular token. When the shared token
 * selector for accounts lands, this function becomes a call to it and nothing
 * else here changes.
 */
import { openCarrierToken } from '../../tunnels/lifecycle.ts'
import type { DnsCertContext } from './context.ts'

export type DnsTokenNeed = { zoneId: string } | 'any'

/** The plain token text, or null when no active token on the account fits. */
export async function openDnsToken(
  ctx: Pick<DnsCertContext, 'db' | 'secrets'>,
  carrierId: string,
  need: DnsTokenNeed
): Promise<string | null> {
  return await openCarrierToken(
    ctx.db,
    ctx.secrets,
    carrierId,
    need === 'any' ? { anyDns: true } : { zoneId: need.zoneId }
  )
}
