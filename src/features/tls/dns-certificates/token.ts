/**
 * The ONE place a DNS-validated certificate picks the provider token it uses.
 * It asks the shared token selector for an active token on the account that can
 * edit DNS for the zone (matched by zone id), so renewal and cleanup never
 * depend on one particular token: the order keeps only the account. A call
 * the provider refuses with one token is tried with the next (`withDnsToken`).
 */
import {
  BadgeRefused,
  BadgeUnavailable,
  openBestBadge,
  useBadges,
} from '../../tunnels/badge-use.ts'
import { TunnelProviderError } from '../../tunnels/errors.ts'
import type { DnsCertContext } from './context.ts'

export type DnsTokenNeed = { zone: { id: string; name?: string } }

/** The plain token text, or null when no active token on the account fits. */
export async function openDnsToken(
  ctx: Pick<DnsCertContext, 'db' | 'secrets'>,
  carrierId: string,
  need: DnsTokenNeed
): Promise<string | null> {
  const opened = await openBestBadge(ctx.db, ctx.secrets, carrierId, {
    capability: 'dns',
    zone: need.zone,
  })
  return opened?.token ?? null
}

/** The provider's own refusal, so an order with no token for a zone fails in plain words. */
export function noDnsTokenError(): TunnelProviderError {
  return new TunnelProviderError(
    'forbidden',
    'No token on this account can edit DNS records for the zone',
    null
  )
}

/**
 * Do one DNS call for a zone with the account's tokens that can edit it, best
 * first. A token the provider refuses (401, or 403 for the zone) is marked as
 * the shared selector does and the next one is tried. With no token left the
 * provider's own `forbidden` is thrown, so the order fails in plain words.
 */
export async function withDnsToken<T>(
  ctx: Pick<DnsCertContext, 'db' | 'secrets'>,
  carrierId: string,
  zone: { id: string; name?: string },
  run: (token: string) => Promise<T>
): Promise<T> {
  try {
    const used = await useBadges(ctx.db, ctx.secrets, carrierId, { capability: 'dns', zone }, run)
    return used.value
  } catch (err) {
    if (err instanceof BadgeUnavailable || err instanceof BadgeRefused) {
      throw noDnsTokenError()
    }
    throw err
  }
}
