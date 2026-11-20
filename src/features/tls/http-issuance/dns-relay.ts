/**
 * The DNS relay for a server-placed order over the DNS proof. The daemon asks
 * the panel to publish the challenge records (`acme-dns-publish`), waits for
 * the panel to say they are visible (`acme-dns-published`), and asks for them
 * to be removed when it is done (`acme-dns-remove`). The panel holds the
 * organization's DNS token; the token never leaves it, and the daemon only
 * ever learns whether the records are out there.
 *
 * Runtime neutral: the database, the DNS host, the zone lookup, the read-back
 * and the reply are all injected, so the Deno runtime and the Workers cell run
 * this same code. Nothing here talks to the certificate authority.
 *
 * Every request is matched to its row by request id inside the reporting
 * server's own organization, and only the issuing server of an open DNS
 * request may publish. A record is written to the row the moment it exists and
 * is only ever removed by the id the provider gave, never by name.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import {
  ACME_DNS_RECORD_NAME_RE,
  ACME_DNS_RECORD_VALUE_RE,
  type AcmeDnsPublishedMessage,
  type AcmeDnsPublishMessage,
  type AcmeDnsRemoveMessage,
  MAX_ACME_DNS_RECORDS,
} from '../../../contracts/cell-protocol.ts'
import { server, tls } from '../../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../../lib/secrets/secrets.ts'
import {
  ChallengeTargetError,
  type DnsChallengeProvider,
} from '../dns-certificates/dns-provider.ts'
import { baseName } from '../dns-certificates/names.ts'
import type { PublishedRecord } from '../dns-certificates/order-state.ts'
import { cleanRecords, dnsFor, type RecordsContext } from '../dns-certificates/records.ts'
import {
  findZoneInOrganization,
  writeTarget,
  type ZoneContext,
  zoneFor,
} from '../dns-certificates/zones.ts'
import type { TunnelAdapterRegistry } from '../../tunnels/registry.ts'
import { TunnelProviderError } from '../../tunnels/errors.ts'
import { readDnsCertState } from '../dns-certificates/order-state.ts'
import { readHttpIssuanceState } from './state.ts'

/** How long the records may take to show on the authoritative nameservers. */
export const DNS_READBACK_TIMEOUT_MS = 4 * 60_000
/** The pause between two reads of the records. */
export const DNS_READBACK_POLL_MS = 5_000
/** The longest error sentence sent to the daemon (it keeps 300). */
const MAX_ERROR_CHARS = 280

export type DnsConfirm = (input: {
  dns: DnsChallengeProvider
  zoneId: string
  name: string
  value: string
}) => Promise<boolean>

export type DnsRelayDeps = {
  db: Db
  secrets: DerivedSecretsConfig
  dns: RecordsContext['dns']
  adapters: TunnelAdapterRegistry
  /** One read of the record: true once it is visible where the authority will look. */
  confirm: DnsConfirm
  /** Sends one message to the daemon that asked. */
  reply: (message: AcmeDnsPublishedMessage) => Promise<void>
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  readbackTimeoutMs?: number
  readbackPollMs?: number
}

/**
 * Read the record the way the provider reports it. Works on every runtime, but
 * says nothing about the nameservers themselves: Workers cannot ask a specific
 * nameserver, so there the provider's own read is all the panel can check.
 */
export const confirmThroughProvider: DnsConfirm = async ({ dns, zoneId, name, value }) =>
  ((await dns.txtValues?.({ zoneId, name })) ?? []).includes(value)

type Located = {
  rowId: string
  organizationId: string
  metadata: Record<string, unknown>
  issuingServerId: string
  open: boolean
  dns: boolean
  orderNames: string[]
}

async function locate(db: Db, serverId: string, requestId: string): Promise<Located | null> {
  const [reporter] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!reporter?.organizationId) return null
  const [row] = await db
    .select({ id: tls.id, metadata: tls.metadata })
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, reporter.organizationId),
        eq(tls.source, 'lets_encrypt'),
        sql`${tls.metadata} -> 'httpCert' ->> 'requestId' = ${requestId}`
      )
    )
    .limit(1)
  const state = row ? readHttpIssuanceState(row.metadata) : null
  if (!row || !state) return null
  return {
    rowId: row.id,
    organizationId: reporter.organizationId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    issuingServerId: state.issuingServerId,
    open: state.endedAt === null,
    dns: state.challenge === 'dns-01',
    orderNames: state.orderNames,
  }
}

/** A sentence for the daemon: the provider's own words when it gave any, otherwise a fixed one. */
function sentence(err: unknown): string {
  if (err instanceof ChallengeTargetError) {
    return `The challenge name for ${err.name_} is an alias for ${err.target}. ${err.message}`
  }
  const text =
    err instanceof TunnelProviderError && err.message
      ? err.message
      : 'The DNS records could not be published.'
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARS)
}

function refusal(located: Located | null, serverId: string): string | null {
  if (!located || located.issuingServerId !== serverId) return 'This order is not known here.'
  if (!located.open) return 'This order is no longer open.'
  if (!located.dns) return 'This order does not use DNS records.'
  return null
}

/** The record names an order may ask for: one per base name of the names ordered. */
function allowedNames(orderNames: readonly string[]): Set<string> {
  return new Set(orderNames.map((name) => `_acme-challenge.${baseName(name)}`))
}

/** Checks the records against the order and the wire limits; a plain sentence when they do not fit. */
export function checkRecords(
  records: readonly { name: string; value: string }[],
  orderNames: readonly string[]
): string | null {
  const allowed = allowedNames(orderNames)
  if (records.length === 0 || records.length > MAX_ACME_DNS_RECORDS) {
    return 'The number of records is not allowed.'
  }
  if (records.length > Math.max(1, orderNames.length)) {
    return 'More records were asked for than the order has names.'
  }
  const seen = new Set<string>()
  for (const record of records) {
    if (!ACME_DNS_RECORD_NAME_RE.test(record.name) || record.name.length > 253) {
      return 'A record name is not allowed.'
    }
    if (!ACME_DNS_RECORD_VALUE_RE.test(record.value)) return 'A record value is not allowed.'
    if (!allowed.has(record.name)) return 'A record name does not belong to this order.'
    const key = `${record.name}\n${record.value}`
    if (seen.has(key)) return 'A record was asked for twice.'
    seen.add(key)
  }
  return null
}

async function rememberRecord(db: Db, rowId: string, record: PublishedRecord): Promise<void> {
  await db
    .update(tls)
    .set({
      metadata: sql`jsonb_set(${tls.metadata}, '{dnsCert,records}', coalesce(${tls.metadata} #> '{dnsCert,records}', '[]'::jsonb) || ${JSON.stringify([record])}::jsonb)`,
    })
    .where(and(eq(tls.id, rowId), eq(tls.source, 'lets_encrypt')))
}

async function rememberAccount(
  db: Db,
  rowId: string,
  account: { carrierId: string; zones: { id: string; name: string }[] }
): Promise<void> {
  await db
    .update(tls)
    .set({
      metadata: sql`jsonb_set(${tls.metadata}, '{dnsCert}', coalesce(${tls.metadata} -> 'dnsCert', '{}'::jsonb) || ${JSON.stringify(account)}::jsonb)`,
    })
    .where(and(eq(tls.id, rowId), eq(tls.source, 'lets_encrypt')))
}

async function writeRecords(db: Db, rowId: string, records: readonly PublishedRecord[]) {
  await db
    .update(tls)
    .set({
      metadata: sql`jsonb_set(${tls.metadata}, '{dnsCert,records}', ${JSON.stringify(records)}::jsonb)`,
    })
    .where(and(eq(tls.id, rowId), eq(tls.source, 'lets_encrypt')))
}

/** Remove what the row lists, by id, and keep on the row whatever would not go. */
async function removeListed(deps: DnsRelayDeps, located: Located): Promise<void> {
  const [row] = await deps.db
    .select({ metadata: tls.metadata })
    .from(tls)
    .where(eq(tls.id, located.rowId))
    .limit(1)
  const state = readDnsCertState(row?.metadata)
  if (!state || state.records.length === 0) return
  const cleaned = await cleanRecords(deps, { organizationId: located.organizationId }, state)
  await writeRecords(deps.db, located.rowId, cleaned.records)
}

async function waitVisible(
  deps: DnsRelayDeps,
  dns: DnsChallengeProvider,
  made: { zoneId: string; name: string; value: string }
): Promise<boolean> {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const until = now().getTime() + (deps.readbackTimeoutMs ?? DNS_READBACK_TIMEOUT_MS)
  for (;;) {
    try {
      if (await deps.confirm({ dns, ...made })) return true
    } catch {
      // A failed read is the same as not visible yet.
    }
    if (now().getTime() >= until) return false
    await sleep(deps.readbackPollMs ?? DNS_READBACK_POLL_MS)
  }
}

async function publish(
  deps: DnsRelayDeps,
  located: Located,
  records: readonly { name: string; value: string }[]
): Promise<void> {
  const ctx: ZoneContext = {
    db: deps.db,
    secrets: deps.secrets,
    dns: deps.dns,
    adapters: deps.adapters,
  }
  const now = deps.now ?? (() => new Date())
  // The zone of every record, on one carrier of the organization (a certificate
  // is made through one account).
  const first = await findZoneInOrganization(
    ctx,
    located.organizationId,
    records[0].name.slice('_acme-challenge.'.length)
  )
  if (!first)
    throw new TunnelProviderError(
      'forbidden',
      'No token on this account can edit DNS records for the zone',
      null
    )
  const carrier = first.carrier
  const zones = [first.zone]
  await rememberAccount(deps.db, located.rowId, { carrierId: carrier.id, zones })
  const placed: { zoneId: string; name: string; value: string }[] = []
  try {
    for (const record of records) {
      const base = record.name.slice('_acme-challenge.'.length)
      const known = zoneFor(zones, base)
      const zone =
        known ??
        (await (async () => {
          const found = await findZoneInOrganization(ctx, located.organizationId, base)
          if (!found || found.carrier.id !== carrier.id) {
            throw new TunnelProviderError(
              'forbidden',
              'No token on this account can edit DNS records for the zone',
              null
            )
          }
          zones.push(found.zone)
          return found.zone
        })())
      const where = await writeTarget(ctx, located.organizationId, carrier, {
        name: record.name,
        zoneId: zone.id,
      })
      const dns = await dnsFor(
        ctx,
        { organizationId: located.organizationId },
        { carrierId: carrier.id },
        where.zoneId
      )
      const ref = await dns.present({ zoneId: where.zoneId, name: where.name, value: record.value })
      await rememberRecord(deps.db, located.rowId, {
        zoneId: where.zoneId,
        recordId: ref.recordId,
        name: where.name,
        createdAt: now().toISOString(),
      })
      placed.push({ zoneId: where.zoneId, name: where.name, value: record.value })
    }
    for (const made of placed) {
      const dns = await dnsFor(
        ctx,
        { organizationId: located.organizationId },
        { carrierId: carrier.id },
        made.zoneId
      )
      if (!(await waitVisible(deps, dns, made))) {
        throw new TunnelProviderError(
          'unreachable',
          'The challenge record was created but is not visible on the nameservers yet.',
          null
        )
      }
    }
  } catch (err) {
    await removeListed(deps, located).catch(() => undefined)
    throw err
  }
}

const inFlight = new Set<string>()

/**
 * Handle `acme-dns-publish`: publish the records, wait until they read back,
 * and answer the daemon once. Resolves when the answer has been sent. A second
 * publish for a request that is already being served is ignored.
 */
export async function handleDnsPublish(
  deps: DnsRelayDeps,
  serverId: string,
  message: AcmeDnsPublishMessage
): Promise<void> {
  const now = deps.now ?? (() => new Date())
  const answer = (ok: boolean, error?: string) =>
    deps
      .reply({
        type: 'acme-dns-published',
        requestId: message.requestId,
        ok,
        ...(error ? { error } : {}),
        at: now().toISOString(),
      })
      .catch(() => undefined)
  if (inFlight.has(message.requestId)) return
  inFlight.add(message.requestId)
  try {
    const located = await locate(deps.db, serverId, message.requestId)
    const refused = refusal(located, serverId)
    if (refused || !located) return await answer(false, refused ?? undefined)
    const unfit = checkRecords(message.records, located.orderNames)
    if (unfit) return await answer(false, unfit)
    try {
      await publish(deps, located, message.records)
    } catch (err) {
      return await answer(false, sentence(err))
    }
    await answer(true)
  } finally {
    inFlight.delete(message.requestId)
  }
}

/**
 * Handle `acme-dns-remove`: take away the records the panel made for the
 * request, by id. Only the issuing server may ask, and it may ask after the
 * request closed. No answer is sent; whatever would not go stays listed for
 * the cleanup tick.
 */
export async function handleDnsRemove(
  deps: DnsRelayDeps,
  serverId: string,
  message: AcmeDnsRemoveMessage
): Promise<void> {
  const located = await locate(deps.db, serverId, message.requestId)
  if (!located || located.issuingServerId !== serverId) return
  await removeListed(deps, located)
}

export function isDnsRelayMessage(message: {
  type: string
}): message is AcmeDnsPublishMessage | AcmeDnsRemoveMessage {
  return message.type === 'acme-dns-publish' || message.type === 'acme-dns-remove'
}

/** Route one validated inbound frame to its handler. */
export async function handleDnsRelayInbound(
  deps: DnsRelayDeps,
  serverId: string,
  message: AcmeDnsPublishMessage | AcmeDnsRemoveMessage
): Promise<void> {
  if (message.type === 'acme-dns-publish') await handleDnsPublish(deps, serverId, message)
  else await handleDnsRemove(deps, serverId, message)
}
