/**
 * The DNS records a DNS-validated certificate makes, reached through the DNS
 * provider only: the DNS host for one zone, and removing the records the panel
 * made, by the id the provider gave. Nothing here talks to the certificate
 * authority, so the leftover-record cleanup (`cleanup.ts`) can run with
 * ordering turned off. `records.hostfree.test.ts` pins that.
 */
import { findCarrier } from '../../tunnels/records.ts'
import type { TunnelProvider } from '../../tunnels/vocabulary.ts'
import type { DnsCertContext } from './context.ts'
import type { DnsChallengeProvider } from './dns-provider.ts'
import type { DnsCertState, PublishedRecord } from './order-state.ts'
import { noDnsTokenError, openDnsToken, withDnsToken } from './token.ts'

/** What the DNS calls need to know about the row: whose account to use. */
export type RecordsRow = { organizationId: string }

/** The parts of the context the DNS calls use. */
export type RecordsContext = Pick<DnsCertContext, 'db' | 'secrets' | 'dns'>

/**
 * The DNS host for one zone. Each call is made with a token of the account
 * that reaches the zone, picked at call time, so a token removed or refused
 * after the order started is replaced by another one that covers the zone.
 */
export async function dnsFor(
  ctx: RecordsContext,
  row: RecordsRow,
  state: Pick<DnsCertState, 'carrierId'>,
  zoneId: string
): Promise<DnsChallengeProvider> {
  const carrier = await findCarrier(ctx.db, row.organizationId, state.carrierId)
  const token = carrier ? await openDnsToken(ctx, carrier.id, { zone: { id: zoneId } }) : null
  if (!carrier || !token) throw noDnsTokenError()
  const provider = carrier.provider as TunnelProvider
  const call = <T>(fn: (dns: DnsChallengeProvider) => Promise<T>) =>
    withDnsToken(ctx, carrier.id, { id: zoneId }, (t) => fn(ctx.dns(provider, t)))
  // The optional reads stay optional: a host without them is not asked.
  const shape = ctx.dns(provider, token)
  return {
    lookupCname: (input) => call((dns) => dns.lookupCname(input)),
    present: (input) => call((dns) => dns.present(input)),
    remove: (ref) => call((dns) => dns.remove(ref)),
    ...(shape.checkZone
      ? { checkZone: (id: string) => call(async (dns) => await dns.checkZone?.(id)) }
      : {}),
    ...(shape.txtValues
      ? {
          txtValues: (input: { zoneId: string; name: string }) =>
            call(async (dns) => (await dns.txtValues?.(input)) ?? []),
        }
      : {}),
  }
}

/**
 * Remove every record this panel made for the row, by id. A record that cannot
 * be removed stays on the list for the next try; nothing else is ever touched.
 */
export async function cleanRecords<S extends Pick<DnsCertState, 'carrierId' | 'records'>>(
  ctx: RecordsContext,
  row: RecordsRow,
  state: S
): Promise<S> {
  const left = await Promise.all(
    state.records.map(async (rec): Promise<PublishedRecord | null> => {
      try {
        const dns = await dnsFor(ctx, row, state, rec.zoneId)
        await dns.remove({ zoneId: rec.zoneId, recordId: rec.recordId })
        return null
      } catch {
        return rec
      }
    })
  )
  return { ...state, records: left.filter((r): r is PublishedRecord => r !== null) }
}
