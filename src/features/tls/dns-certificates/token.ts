/**
 * The ONE place a DNS-validated certificate picks the provider token it uses.
 * It asks the shared token selector for an active token on the account that can
 * edit DNS for the zone (matched by zone id), so renewal and cleanup never
 * depend on one particular token: the order keeps only the account. A call
 * the provider refuses with one token is tried with the next (`withDnsToken`).
 * To look a zone up before it is known, any token that reaches some DNS zone
 * will do (`withAnyDnsToken`).
 */
import { firstSequential } from '../../../lib/sequential.ts'
import { type BadgeRow, listBadges, openBadgeToken, toApiBadge } from '../../tunnels/records.ts'
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

/** Active tokens that reach some DNS zone, the most recently checked first. */
async function dnsCapableBadges(
  ctx: Pick<DnsCertContext, 'db'>,
  carrierId: string
): Promise<BadgeRow[]> {
  const rows = (await listBadges(ctx.db, carrierId)).filter(
    (row) => row.status === 'active' && toApiBadge(row).capabilities.dns.length > 0
  )
  return rows.sort((a, b) => (b.lastCheckedAt ?? '').localeCompare(a.lastCheckedAt ?? ''))
}

function refusedToken(err: unknown): boolean {
  return (
    err instanceof TunnelProviderError && (err.code === 'unauthorized' || err.code === 'forbidden')
  )
}

/**
 * Do a zone lookup with any DNS token of the account, the most recently
 * checked first, and try the next when the provider refuses one. A refusal
 * here says nothing about one zone, so no token's stored rights change.
 * Null when the account has no such token; the last refusal is thrown when
 * every one was refused.
 */
export async function withAnyDnsToken<T>(
  ctx: Pick<DnsCertContext, 'db' | 'secrets'>,
  carrierId: string,
  run: (token: string) => Promise<T>
): Promise<{ value: T } | null> {
  const rows = await dnsCapableBadges(ctx, carrierId)
  let refusal: unknown = null
  const done = await firstSequential(rows, async (row) => {
    const token = await openBadgeToken(ctx.db, ctx.secrets, row)
    if (token === null) return undefined
    try {
      return { value: await run(token) }
    } catch (err) {
      if (!refusedToken(err)) throw err
      refusal = err
      return undefined
    }
  })
  if (done) return done
  if (refusal !== null) throw refusal
  return null
}
