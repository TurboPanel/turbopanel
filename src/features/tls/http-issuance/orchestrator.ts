/**
 * One certificate per name set, ordered by one serving server.
 *
 * The panel decides, schedules and tracks; the chosen server's daemon places
 * the order from its own addresses. This file is the panel's half: pick the
 * participants, send the forwards, wait for every helper's answer, send the
 * order, and move the request along as the daemon reports. State lives in the
 * library row's metadata (`httpCert`, see `state.ts`); no table, no timer.
 *
 * Every step takes the row under `for update`, re-reads it, decides from the
 * stored state and the clock, writes, and only then sends. A send that fails
 * after the write is caught by the silence timeouts, so nothing waits forever.
 */
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { notPinnedBySiteCondition } from '../unused-letsencrypt.ts'
import type { Db } from '../../../db/connection.ts'
import {
  deployment,
  environment,
  hostname,
  hosting,
  organization,
  server,
  service,
  tls,
} from '../../../db/schema.ts'
import type { DaemonOutboundEnvelope } from '../../../contracts/cell-protocol.ts'
import { generateDeliveryId, generateRequestId } from '../../../contracts/cell-protocol.ts'
import { loadServerPublicAddresses } from '../../net/client-addresses.ts'
import { readHostingWwwMode } from '../../hostings/hosting-options.ts'
import { forEachSequential } from '../../../lib/sequential.ts'
import { type DnsLookup, resolveNameAddresses } from '../../hostings/hosting-dns-check.ts'
import type { TlsAcmeMetadata } from '../../../lib/tls/types.ts'
import { mayStartAttempt, pruneAttempts } from './attempts.ts'
import { ACME_ISSUE_DNS_FEATURE } from '../../../lib/version-wire.ts'
import { loadOrgOrderFacts, mayStartNewCertificate, recordNewCertificateStart } from './caps.ts'
import {
  type Choice,
  chooseDnsIssuer,
  chooseParticipants,
  type DnsChoice,
  type ServingServer,
} from './choose.ts'
import {
  applyForwardReports,
  decideOpen,
  type ForwardReport,
  mayReplaceKey,
  failedState,
  publicMarker,
  DNS_REQUEST_LIFETIME_MS,
  REQUEST_LIFETIME_MS,
  type ReplaceKeyRefusal,
  waitingMarker,
} from './progress.ts'
import {
  closedAsIssued,
  type ForwardResult,
  type HttpIssuanceState,
  type IssuanceChallenge,
  newHttpIssuanceState,
  readHttpIssuanceState,
  type RosterEntry,
  withHttpIssuanceState,
} from './state.ts'
import { waitingText } from './status-text.ts'
import { orderNamesFor, type PinningSite } from './names.ts'

export type HttpIssuanceDeps = {
  db: Db
  now?: () => Date
  /** Puts one envelope in the server's cell outbox. */
  send: (serverId: string, envelope: DaemonOutboundEnvelope) => Promise<void>
  dnsLookup: DnsLookup
  isOnline: (serverId: string) => Promise<boolean>
  /**
   * The features the server's daemon lists. Without this no server counts as able to
   * order over the DNS proof, so a DNS order is never sent anywhere.
   */
  serverFeatures?: (serverId: string) => Promise<readonly string[]>
  /** The organization's certificate contact address, or null when it has none (orders cannot start). */
  contactEmail: (organizationId: string) => Promise<string | null>
  /** Order from the authority's test directory (a platform setting). */
  staging: boolean
  newRequestId?: () => string
}

const clock = (deps: Pick<HttpIssuanceDeps, 'now'>): Date => (deps.now ?? (() => new Date()))()

type RowFacts = {
  id: string
  organizationId: string
  /** The row's own names: what a stored pair must cover before a request closes. */
  names: string[]
  /** What an order asks for: the row's names plus the www names its sites add. */
  orderNames: string[]
  hasPair: boolean
  metadata: Record<string, unknown>
}

function namesOf(metadata: unknown): string[] {
  const names = (metadata as { dnsNames?: unknown } | null)?.dnsNames
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
}

function hostnamesOf(options: unknown): string[] {
  const names = (options as { hostnames?: unknown } | null)?.hostnames
  return Array.isArray(names)
    ? names.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : []
}

/** A site pins the row for the whole site or for any one of its names. */
function pinsRow(tlsId: string) {
  return or(
    eq(hosting.tlsId, tlsId),
    sql`exists (select 1 from ${hostname} where ${hostname.hostingId} = ${hosting.id} and ${hostname.tlsId} = ${tlsId})`
  )
}

/** The typed names and www mode of every site that pins the row. */
async function loadPinningSites(db: Db, tlsId: string): Promise<PinningSite[]> {
  const rows = await db.select({ options: hosting.options }).from(hosting).where(pinsRow(tlsId))
  return rows.map((row) => ({
    hostnames: hostnamesOf(row.options),
    www: readHostingWwwMode(row.options),
  }))
}

/** What an order for the row asks for (see `names.ts`); the row's own names when it cannot be ordered here. */
async function orderNamesOf(db: Db, tlsId: string, metadata: unknown): Promise<string[]> {
  const typed = namesOf(metadata)
  return orderNamesFor(typed, await loadPinningSites(db, tlsId)) ?? typed
}

async function lockRow(tx: Db, tlsId: string): Promise<RowFacts | null> {
  const [row] = await tx
    .select({
      id: tls.id,
      organizationId: tls.organizationId,
      status: tls.status,
      source: tls.source,
      metadata: tls.metadata,
      hasKey: sql<boolean>`${tls.privateKeyPem} is not null`,
    })
    .from(tls)
    .where(eq(tls.id, tlsId))
    .for('update')
  if (row?.source !== 'lets_encrypt' || row.status !== 'automatic') return null
  return {
    id: row.id,
    organizationId: row.organizationId,
    names: namesOf(row.metadata),
    orderNames: await orderNamesOf(tx, row.id, row.metadata),
    hasPair: row.hasKey === true && readHttpIssuanceState(row.metadata)?.centralPair === true,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }
}

/** The organization's Let's Encrypt switch, read under the row lock. */
async function acmeEnabledFor(tx: Db, organizationId: string): Promise<boolean> {
  const [org] = await tx
    .select({ isAcmeEnabled: organization.isAcmeEnabled })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return org?.isAcmeEnabled === true
}

async function writeState(
  tx: Db,
  row: RowFacts,
  state: HttpIssuanceState,
  now: Date
): Promise<void> {
  const acme = publicMarker(row.metadata.acme as TlsAcmeMetadata | undefined, state)
  await tx
    .update(tls)
    .set({
      metadata: { ...withHttpIssuanceState(row.metadata, state), acme },
      updatedAt: now.toISOString(),
    })
    .where(eq(tls.id, row.id))
}

async function writeWaiting(
  tx: Db,
  row: RowFacts,
  text: string,
  now: Date,
  challenge: IssuanceChallenge = 'http-01'
): Promise<void> {
  const previous = row.metadata.acme as TlsAcmeMetadata | undefined
  // The same words again: leave the row alone, so a waiting row is not rewritten every minute.
  if (previous?.stage === 'waiting' && previous.warning === text) return
  const acme = waitingMarker(previous, text, challenge)
  await tx
    .update(tls)
    .set({ metadata: { ...row.metadata, acme }, updatedAt: now.toISOString() })
    .where(eq(tls.id, row.id))
}

type ServingRow = { serverId: string; label: string }

/** Every server that runs a hosting pinned to the row, by its environment or its deployments. */
async function loadServingServers(db: Db, tlsId: string): Promise<ServingRow[]> {
  const own = await db
    .select({ serverId: environment.serverId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .where(pinsRow(tlsId))
  const deployed = await db
    .select({ serverId: deployment.serverId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(deployment, eq(deployment.environmentId, service.environmentId))
    .where(and(pinsRow(tlsId), ne(deployment.status, 'draining')))
  const ids = [...new Set([...own, ...deployed].flatMap((r) => r.serverId ?? []))]
  if (ids.length === 0) return []
  const names = await db
    .select({ id: server.id, name: server.name })
    .from(server)
    .where(inArray(server.id, ids))
  const label = new Map(names.map((n) => [n.id, n.name ?? 'A server']))
  return ids.map((serverId) => ({ serverId, label: label.get(serverId) ?? 'A server' }))
}

/** Does the server's daemon list the DNS order feature? A read that fails counts as no. */
async function serverTakesDnsOrders(
  deps: Pick<HttpIssuanceDeps, 'serverFeatures'>,
  serverId: string
): Promise<boolean> {
  try {
    return ((await deps.serverFeatures?.(serverId)) ?? []).includes(ACME_ISSUE_DNS_FEATURE)
  } catch {
    return false
  }
}

async function describeServers(
  deps: HttpIssuanceDeps,
  rows: ServingRow[]
): Promise<ServingServer[]> {
  return await Promise.all(
    rows.map(async (r) => {
      const [online, addresses, takesDnsOrders] = await Promise.all([
        deps.isOnline(r.serverId),
        loadServerPublicAddresses(deps.db, r.serverId),
        serverTakesDnsOrders(deps, r.serverId),
      ])
      return {
        serverId: r.serverId,
        label: r.label,
        online,
        addresses,
        takesDnsOrders,
      }
    })
  )
}

/** What the name's DNS answers with: the addresses every name agrees on, else all of them. */
async function dnsAddressesOf(lookup: DnsLookup, names: readonly string[]): Promise<string[]> {
  const perName = await Promise.all(names.map((n) => resolveNameAddresses(lookup, n)))
  const first = perName[0] ?? []
  const common = first.filter((a) => perName.every((list) => list.includes(a)))
  return common.length > 0 ? common : [...new Set(perName.flat())]
}

function envelope<K extends DaemonOutboundEnvelope['kind']>(
  now: Date,
  kind: K,
  rest: Omit<
    Extract<DaemonOutboundEnvelope, { kind: K }>,
    'kind' | 'deliveryId' | 'requestId' | 'at'
  >
): DaemonOutboundEnvelope {
  return {
    kind,
    deliveryId: generateDeliveryId(),
    requestId: generateRequestId(),
    at: now.toISOString(),
    ...rest,
  } as DaemonOutboundEnvelope
}

export async function sendAll(
  deps: HttpIssuanceDeps,
  items: Array<{ serverId: string; envelope: DaemonOutboundEnvelope }>
): Promise<string[]> {
  const failed: string[] = []
  await forEachSequential(items, async (item) => {
    try {
      // The last gate before the wire: an order over the DNS proof goes only to a daemon
      // that lists the feature now. An older daemon drops the field and would run the HTTP
      // proof for names the panel meant to prove over DNS.
      if (
        item.envelope.kind === 'acme-issue-request' &&
        item.envelope.challenge === 'dns-01' &&
        !(await serverTakesDnsOrders(deps, item.serverId))
      ) {
        failed.push(item.serverId)
        return
      }
      await deps.send(item.serverId, item.envelope)
    } catch {
      failed.push(item.serverId)
    }
  })
  return failed
}

/** The names a request asked for when it started; the row's current ones for a request an older release started. */
function requestNames(state: HttpIssuanceState, row: Pick<RowFacts, 'orderNames'>): string[] {
  return state.orderNames.length > 0 ? state.orderNames : row.orderNames
}

function orderEnvelope(
  now: Date,
  row: Pick<RowFacts, 'id' | 'orderNames'>,
  state: HttpIssuanceState,
  helpers: Array<{ serverId: string; address: string }>,
  contactEmail: string
): DaemonOutboundEnvelope {
  return envelope(now, 'acme-issue-request', {
    acmeRequestId: state.requestId,
    tlsId: row.id,
    names: requestNames(state, row),
    directory: state.directory,
    contactEmail,
    ...(state.challenge === 'dns-01' ? { challenge: 'dns-01' as const } : {}),
    startByIso: state.startByAt,
    helpers,
  })
}

/**
 * Whether names may be ordered over the HTTP proof: at least one, and no wildcard
 * (that needs the DNS proof). Several names are fine.
 */
export function isHttpOrderable(names: readonly string[]): boolean {
  return names.length >= 1 && names.every((name) => !name.includes('*'))
}

/** Most names one order carries (the daemon's own limit). */
const MAX_ORDER_NAMES = 100

/** Whether names may be ordered over the DNS proof: one to the daemon's limit, each a name or `*.name`. */
export function isDnsOrderable(names: readonly string[]): boolean {
  return (
    names.length >= 1 &&
    names.length <= MAX_ORDER_NAMES &&
    names.every(
      (name) => /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name) && name.length <= 253
    )
  )
}

/**
 * Which proof a row is ordered with: the DNS proof when it was made for it (the
 * public marker) or when any name is a wildcard, the HTTP proof otherwise.
 */
export function challengeFor(metadata: unknown, names: readonly string[]): IssuanceChallenge {
  const acme = (metadata as { acme?: { challengeType?: unknown } } | null)?.acme
  return acme?.challengeType === 'dns-01' || names.some((name) => name.includes('*'))
    ? 'dns-01'
    : 'http-01'
}

export type StartOutcome =
  | 'started'
  | 'ordering'
  | 'waiting'
  | 'backoff'
  /** The chosen issuing server already has an order open; this one waits its turn. */
  | 'busy'
  | 'not_due'
  | 'not_eligible'

async function gather(
  deps: HttpIssuanceDeps,
  row: Pick<RowFacts, 'id' | 'orderNames'>,
  previous: HttpIssuanceState | null
): Promise<{ choice: Choice; servers: ServingServer[] }> {
  const servers = await describeServers(deps, await loadServingServers(deps.db, row.id))
  // Nothing to choose from until the first pass over the servers: skip the DNS lookup.
  if (servers.length === 0) {
    return { choice: { ok: false, reason: 'no_servers', skipped: [] }, servers }
  }
  const dnsAddresses = await dnsAddressesOf(deps.dnsLookup, row.orderNames)
  const choice = chooseParticipants({
    servers,
    dnsAddresses,
    previousIssuerId: previous?.issuingServerId ?? null,
    avoidServerId: previous?.avoidServerId ?? null,
  })
  return { choice, servers }
}

async function gatherDns(
  deps: HttpIssuanceDeps,
  row: Pick<RowFacts, 'id'>,
  previous: HttpIssuanceState | null
): Promise<{ choice: DnsChoice; servers: ServingServer[] }> {
  const servers = await describeServers(deps, await loadServingServers(deps.db, row.id))
  const choice = chooseDnsIssuer({
    servers,
    previousIssuerId: previous?.issuingServerId ?? null,
    avoidServerId: previous?.avoidServerId ?? null,
  })
  return { choice, servers }
}

function rosterOf(choice: Extract<Choice, { ok: true }>): RosterEntry[] {
  return [
    { serverId: choice.issuer.serverId, label: choice.issuer.label, role: 'issuer' },
    ...choice.helpers.map((h) => ({
      serverId: h.server.serverId,
      label: h.server.label,
      role: 'helper' as const,
    })),
    ...choice.skipped.map((s) => ({
      serverId: s.server.serverId,
      label: s.server.label,
      role: 'skipped' as const,
      skip: s.reason,
    })),
  ]
}

function dnsRosterOf(choice: Extract<DnsChoice, { ok: true }>): RosterEntry[] {
  return [
    { serverId: choice.issuer.serverId, label: choice.issuer.label, role: 'issuer' },
    ...choice.skipped.map((s) => ({
      serverId: s.server.serverId,
      label: s.server.label,
      role: 'skipped' as const,
      skip: s.reason,
    })),
  ]
}

type Outgoing = Array<{ serverId: string; envelope: DaemonOutboundEnvelope }>

type StepResult = {
  outcome: StartOutcome
  send: Outgoing
  state?: HttpIssuanceState
  /** False for courtesy messages (a failed send changes nothing). */
  required?: boolean
}

/** The state a fresh request starts in, with no helper answers yet. */
function freshState(params: {
  deps: HttpIssuanceDeps
  now: Date
  choice: Extract<Choice, { ok: true }>
  previous: HttpIssuanceState | null
  staging: boolean
  orderNames: string[]
}): HttpIssuanceState {
  const { deps, now, choice, previous } = params
  const startedAt = now.toISOString()
  return newHttpIssuanceState({
    challenge: 'http-01',
    issuingServerId: choice.issuer.serverId,
    requestId: (deps.newRequestId ?? (() => `tlsreq_${crypto.randomUUID()}`))(),
    startedAt,
    startByAt: new Date(now.getTime() + REQUEST_LIFETIME_MS).toISOString(),
    forwards: choice.helpers.map((h) => ({
      serverId: h.server.serverId,
      outcome: 'pending' as const,
      reason: null,
      at: null,
    })),
    helperAddresses: choice.helpers.map((h) => ({
      serverId: h.server.serverId,
      address: h.address,
    })),
    attemptTimes: [...pruneAttempts(previous?.attemptTimes ?? [], now), startedAt],
    directory: params.staging ? 'staging' : 'production',
    consecutiveFailures: previous?.consecutiveFailures ?? 0,
    roster: rosterOf(choice),
    centralPair: previous?.centralPair ?? false,
    issueTimes: previous?.issueTimes ?? [],
    orderNames: params.orderNames,
  })
}

/**
 * The state a DNS request starts in: no helpers and nothing to forward, so the order
 * is sent at once and the request is already `ordering`. It lives a shorter time than an
 * HTTP request, since the daemon gives up on its own after 10 minutes.
 */
function freshDnsState(params: {
  deps: HttpIssuanceDeps
  now: Date
  choice: Extract<DnsChoice, { ok: true }>
  previous: HttpIssuanceState | null
  staging: boolean
  orderNames: string[]
}): HttpIssuanceState {
  const { deps, now, choice, previous } = params
  const startedAt = now.toISOString()
  return newHttpIssuanceState({
    issuingServerId: choice.issuer.serverId,
    requestId: (deps.newRequestId ?? (() => `tlsreq_${crypto.randomUUID()}`))(),
    startedAt,
    startByAt: new Date(now.getTime() + DNS_REQUEST_LIFETIME_MS).toISOString(),
    challenge: 'dns-01',
    phase: 'ordering',
    orderSentAt: startedAt,
    attemptTimes: [...pruneAttempts(previous?.attemptTimes ?? [], now), startedAt],
    directory: params.staging ? 'staging' : 'production',
    consecutiveFailures: previous?.consecutiveFailures ?? 0,
    roster: dnsRosterOf(choice),
    centralPair: previous?.centralPair ?? false,
    issueTimes: previous?.issueTimes ?? [],
    orderNames: params.orderNames,
  })
}

/** The messages that open a request: forwards to the helpers, or the order itself when there are none. */
function openingMessages(
  now: Date,
  row: RowFacts,
  state: HttpIssuanceState,
  choice: Extract<Choice, { ok: true }>,
  contactEmail: string
): Outgoing {
  const helpers = choice.helpers.map((h) => ({ serverId: h.server.serverId, address: h.address }))
  if (helpers.length === 0) {
    return [
      {
        serverId: state.issuingServerId,
        envelope: orderEnvelope(now, row, state, [], contactEmail),
      },
    ]
  }
  return helpers.map((h) => ({
    serverId: h.serverId,
    envelope: envelope(now, 'acme-proof-forward', {
      acmeRequestId: state.requestId,
      names: requestNames(state, row),
      targetAddress: choice.issuerAddress,
      expiresAtIso: state.startByAt,
    }),
  }))
}

/** First key of the two-key advisory lock taken per issuing server, so it cannot collide with other features' locks. */
const ISSUER_LOCK_NAMESPACE = 0x68747470 // 'http'

/** Whether some row already has an open request asked of this server. */
async function issuerHasOpenOrder(tx: Db, serverId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: tls.id })
    .from(tls)
    .where(
      and(
        sql`${tls.metadata} -> 'httpCert' ->> 'issuingServerId' = ${serverId}`,
        sql`${tls.metadata} -> 'httpCert' ->> 'endedAt' is null`
      )
    )
    .limit(1)
  return rows.length > 0
}

/**
 * The organization's day cap and rate-limit pause, read again under a lock on its
 * row, so two starts at once cannot both pass a cap that only one of them fits
 * under. A row trying again was counted when it first started; only the pause
 * applies to it.
 */
async function capAllowsStart(
  tx: Db,
  row: RowFacts,
  previous: HttpIssuanceState | null,
  now: Date
): Promise<boolean> {
  // A renewal is not a new certificate and has no cap to meet.
  if (row.hasPair) return true
  await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, row.organizationId))
    .for('update')
  const facts = await loadOrgOrderFacts(tx, row.organizationId, now)
  const applied = previous === null ? facts : { ...facts, newStarts: [] }
  return mayStartNewCertificate(applied, now).ok
}

/** Note a new certificate (not a renewal, not a retry) against the organization's day. */
async function noteStart(
  tx: Db,
  row: RowFacts,
  previous: HttpIssuanceState | null,
  now: Date
): Promise<void> {
  if (previous === null && !row.hasPair)
    await recordNewCertificateStart(tx, row.organizationId, now)
}

async function startInTransaction(
  tx: Db,
  params: {
    deps: HttpIssuanceDeps
    now: Date
    tlsId: string
    plan: { challenge: 'http-01'; choice: Choice } | { challenge: 'dns-01'; choice: DnsChoice }
    contactEmail: string
    due: (facts: { hasPair: boolean; metadata: Record<string, unknown> }) => boolean
  }
): Promise<StepResult> {
  const { deps, now, plan, contactEmail } = params
  const row = await lockRow(tx, params.tlsId)
  if (!row) return { outcome: 'not_eligible', send: [] }
  if (!(await acmeEnabledFor(tx, row.organizationId))) return { outcome: 'not_eligible', send: [] }
  const previous = readHttpIssuanceState(row.metadata)
  if (previous?.endedAt === null) return { outcome: 'not_due', send: [] }
  if (!params.due({ hasPair: row.hasPair, metadata: row.metadata })) {
    return { outcome: 'not_due', send: [] }
  }
  const verdict = mayStartAttempt(
    { attemptTimes: previous?.attemptTimes ?? [], nextAttemptAt: previous?.nextAttemptAt ?? null },
    now
  )
  if (!verdict.ok || !(await capAllowsStart(tx, row, previous, now))) {
    return { outcome: 'backoff', send: [] }
  }
  if (!plan.choice.ok) {
    await writeWaiting(tx, row, waitingText(plan.choice.reason), now, plan.challenge)
    return { outcome: 'waiting', send: [] }
  }
  const issuerId = plan.choice.issuer.serverId
  // One order at a time per issuing server: the daemon runs one window at a time, so a
  // second order would only wait behind the first and could pass the silence limit.
  await tx.execute(
    sql`select pg_advisory_xact_lock(${ISSUER_LOCK_NAMESPACE}, hashtext(${issuerId}))`
  )
  if (await issuerHasOpenOrder(tx, issuerId)) return { outcome: 'busy', send: [] }
  if (plan.challenge === 'dns-01') {
    const dnsChoice = plan.choice as Extract<DnsChoice, { ok: true }>
    const state = freshDnsState({
      deps,
      now,
      choice: dnsChoice,
      previous,
      staging: deps.staging,
      orderNames: row.orderNames,
    })
    await writeState(tx, row, state, now)
    await noteStart(tx, row, previous, now)
    return {
      outcome: 'ordering',
      send: [
        {
          serverId: state.issuingServerId,
          envelope: orderEnvelope(now, row, state, [], contactEmail),
        },
      ],
      state,
    }
  }
  const choice = plan.choice as Extract<Choice, { ok: true }>
  const fresh = freshState({
    deps,
    now,
    choice,
    previous,
    staging: deps.staging,
    orderNames: row.orderNames,
  })
  const direct = choice.helpers.length === 0
  const state: HttpIssuanceState = direct
    ? { ...fresh, phase: 'ordering', orderSentAt: fresh.startedAt }
    : fresh
  await writeState(tx, row, state, now)
  await noteStart(tx, row, previous, now)
  return {
    outcome: direct ? 'ordering' : 'started',
    send: openingMessages(now, row, state, choice, contactEmail),
    state,
  }
}

/**
 * A row marked "waiting for a site" whose name now has one, with no server serving
 * it yet: say that instead, so the text matches the real reason.
 */
async function restateNoSiteMarker(db: Db, tlsId: string, now: Date): Promise<void> {
  const noSite = waitingText('no_site')
  await db
    .update(tls)
    .set({
      metadata: sql`jsonb_set(${tls.metadata}, '{acme,warning}', to_jsonb(${waitingText('no_servers')}::text))`,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(tls.id, tlsId),
        sql`${tls.metadata} #>> '{acme,warning}' = ${noSite}`,
        sql`(exists (select 1 from ${hosting} where ${hosting.tlsId} = ${tls.id}) or exists (select 1 from ${hostname} where ${hostname.tlsId} = ${tls.id}))`
      )
    )
}

/**
 * Start an order for one row when `due` says it is time and nothing is open:
 * the wait and the hourly cap allow it, and a server that DNS points at is
 * online. Sends the forwards first; with no helpers the order goes out at once.
 */
export async function startHttpIssuance(
  deps: HttpIssuanceDeps,
  tlsId: string,
  due: (facts: { hasPair: boolean; metadata: Record<string, unknown> }) => boolean
): Promise<StartOutcome> {
  const now = clock(deps)
  const [peek] = await deps.db
    .select({
      metadata: tls.metadata,
      source: tls.source,
      status: tls.status,
      organizationId: tls.organizationId,
      hasKey: sql<boolean>`${tls.privateKeyPem} is not null`,
    })
    .from(tls)
    .where(eq(tls.id, tlsId))
    .limit(1)
  if (peek?.source !== 'lets_encrypt' || peek.status !== 'automatic') return 'not_eligible'
  const names = await orderNamesOf(deps.db, tlsId, peek.metadata)
  const challenge = challengeFor(peek.metadata, names)
  if (challenge === 'dns-01' ? !isDnsOrderable(names) : !isHttpOrderable(names)) {
    return 'not_eligible'
  }
  const previous = readHttpIssuanceState(peek.metadata)
  if (previous?.endedAt === null) return 'not_due'
  // The cheap answers first: nothing to do, a wait or a cap in force, no contact
  // address. None of them looks at DNS or at the servers.
  const meta = (peek.metadata ?? {}) as Record<string, unknown>
  // Only a pair the panel ordered is a renewal; one a server exported is not.
  const ownPair = peek.hasKey === true && previous?.centralPair === true
  if (!due({ hasPair: ownPair, metadata: meta })) return 'not_due'
  const attempts = {
    attemptTimes: previous?.attemptTimes ?? [],
    nextAttemptAt: previous?.nextAttemptAt ?? null,
  }
  if (!mayStartAttempt(attempts, now).ok) return 'backoff'
  const contactEmail = await deps.contactEmail(peek.organizationId)
  if (contactEmail === null || contactEmail.trim() === '') {
    return await waitForContact(deps, peek.organizationId, tlsId, now, challenge)
  }
  // Organization limits: a day's worth of new certificates, and a pause for everyone
  // once the authority said it is rate limiting. A renewal is not a new certificate.
  if (!ownPair) {
    const facts = await loadOrgOrderFacts(deps.db, peek.organizationId, now)
    // A row trying again was counted when it first started; only the pause applies to it.
    const applied = previous === null ? facts : { ...facts, newStarts: [] }
    if (!mayStartNewCertificate(applied, now).ok) return 'backoff'
  }
  const gathered =
    challenge === 'dns-01'
      ? await gatherDns(deps, { id: tlsId }, previous)
      : await gather(deps, { id: tlsId, orderNames: names }, previous)
  // No serving server: the row is left alone.
  if (gathered.servers.length === 0) {
    await restateNoSiteMarker(deps.db, tlsId, now)
    return 'not_eligible'
  }
  const plan =
    challenge === 'dns-01'
      ? { challenge, choice: gathered.choice as DnsChoice }
      : { challenge, choice: gathered.choice as Choice }
  const result = await deps.db.transaction((tx) =>
    startInTransaction(tx as unknown as Db, { deps, now, tlsId, plan, contactEmail, due })
  )
  await deliverOrFail(deps, tlsId, result)
  return result.outcome
}

/**
 * No contact address for the organization. Only database reads: when a server
 * serves the row it says it is waiting for an address (an unchanged marker is not
 * rewritten); otherwise it is not ours and is left alone.
 * Never looks at DNS.
 */
async function waitForContact(
  deps: HttpIssuanceDeps,
  organizationId: string,
  tlsId: string,
  now: Date,
  challenge: IssuanceChallenge
): Promise<StartOutcome> {
  const serving = await loadServingServers(deps.db, tlsId)
  if (serving.length === 0) return 'not_eligible'
  await deps.db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const row = await lockRow(tx, tlsId)
    if (row?.organizationId !== organizationId) return
    await writeWaiting(tx, row, waitingText('no_contact'), now, challenge)
  })
  return 'waiting'
}

/** Send what a step produced; a send that fails closes the request as failed so it is tried again later. */
async function deliverOrFail(
  deps: HttpIssuanceDeps,
  tlsId: string,
  result: StepResult
): Promise<void> {
  if (result.send.length === 0 || !result.state) return
  if (result.required === false) {
    await sendAll(deps, result.send)
    return
  }
  const failed = await sendAll(deps, result.send)
  if (failed.length === 0) return
  const state = result.state
  const blame = failed.includes(state.issuingServerId)
  // A helper that cannot be reached is simply left out of this attempt.
  if (!blame) {
    await recordForwardReports(
      deps,
      tlsId,
      state.requestId,
      failed.map((serverId) => ({
        serverId,
        outcome: 'skipped' as const,
        reason: 'The server could not be reached.',
      }))
    )
    return
  }
  await failOpenRequest(deps, tlsId, state.requestId, 'The server could not be reached.', true)
}

async function recordForwardReports(
  deps: HttpIssuanceDeps,
  tlsId: string,
  requestId: string,
  reports: ForwardReport[]
): Promise<void> {
  const now = clock(deps)
  await deps.db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const row = await lockRow(tx, tlsId)
    const state = row ? readHttpIssuanceState(row.metadata) : null
    if (!row || state?.requestId !== requestId) return
    await writeState(tx, row, applyForwardReports(state, reports, now), now)
  })
}

/** Give up the open request `requestId` with a plain reason. */
export async function failOpenRequest(
  deps: HttpIssuanceDeps,
  tlsId: string,
  requestId: string,
  reason: string,
  blameIssuer: boolean,
  options: { onlyIfUnpinned?: boolean } = {}
): Promise<void> {
  const now = clock(deps)
  await deps.db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const row = await lockRow(tx, tlsId)
    const state = row ? readHttpIssuanceState(row.metadata) : null
    if (!row || state?.requestId !== requestId || state.endedAt !== null) return
    // Read under the row lock: a name pinned again since the sweep looked keeps its order.
    if (options.onlyIfUnpinned) {
      const [pin] = await tx
        .select({ one: sql<number>`1` })
        .from(tls)
        .where(and(eq(tls.id, tlsId), sql`not (${notPinnedBySiteCondition()})`))
      if (pin) return
    }
    await writeState(tx, row, failedState(state, now, reason, blameIssuer), now)
  })
}

async function advanceInTransaction(
  tx: Db,
  params: { deps: HttpIssuanceDeps; now: Date; tlsId: string; contactEmail: string | null }
): Promise<StepResult> {
  const { now } = params
  const row = await lockRow(tx, params.tlsId)
  const state = row ? readHttpIssuanceState(row.metadata) : null
  if (!row || state?.endedAt !== null) return { outcome: 'not_due', send: [] }
  const action = decideOpen(state, now, row.names)
  if (action.kind === 'wait') return { outcome: 'not_due', send: [] }
  if (action.kind === 'close') {
    const closed = closedAsIssued(state, now.toISOString())
    await writeState(tx, row, closed, now)
    return { outcome: 'not_due', send: [] }
  }
  if (action.kind === 'fail') {
    const failed = failedState(state, now, action.reason, action.blameIssuer)
    const ended = { ...failed, endsSentAt: now.toISOString() }
    await writeState(tx, row, ended, now)
    return { outcome: 'backoff', send: endMessages(now, ended), state: ended, required: false }
  }
  if (params.contactEmail === null || params.contactEmail.trim() === '') {
    // The address was taken away while helpers were getting ready: give the attempt up, try again later.
    const failed = failedState(state, now, 'The contact email address was removed.', false)
    const ended = { ...failed, endsSentAt: now.toISOString() }
    await writeState(tx, row, ended, now)
    return { outcome: 'backoff', send: endMessages(now, ended), state: ended, required: false }
  }
  const forwards = state.forwards.map((f) =>
    action.skip.includes(f.serverId)
      ? {
          ...f,
          outcome: 'skipped' as const,
          reason: 'Did not answer in time.',
          at: now.toISOString(),
        }
      : f
  )
  const helpers = readyHelpers(state, forwards)
  const ordering: HttpIssuanceState = {
    ...state,
    forwards,
    phase: 'ordering',
    orderSentAt: now.toISOString(),
  }
  await writeState(tx, row, ordering, now)
  return {
    outcome: 'ordering',
    send: [
      {
        serverId: state.issuingServerId,
        envelope: orderEnvelope(now, row, ordering, helpers, params.contactEmail),
      },
    ],
    state: ordering,
  }
}

/** The helpers that answered ready, with the address the issuing server checks them at. */
function readyHelpers(
  state: HttpIssuanceState,
  forwards: ForwardResult[]
): Array<{ serverId: string; address: string }> {
  return forwards.flatMap((f) => {
    const address = state.helperAddresses.find((h) => h.serverId === f.serverId)?.address
    return f.outcome === 'ready' && address ? [{ serverId: f.serverId, address }] : []
  })
}

/** `acme-proof-forward-end` for every helper that was asked, so they stop at once instead of at expiry. */
function endMessages(now: Date, state: HttpIssuanceState): Outgoing {
  return state.forwards.map((f) => ({
    serverId: f.serverId,
    envelope: envelope(now, 'acme-proof-forward-end', { acmeRequestId: state.requestId }),
  }))
}

/**
 * Move one open request on: send the order once every helper answered (or the
 * wait ran out), or give the request up when a server stayed silent.
 */
export async function advanceHttpIssuance(
  deps: HttpIssuanceDeps,
  tlsId: string
): Promise<StartOutcome> {
  const now = clock(deps)
  const [peek] = await deps.db
    .select({ metadata: tls.metadata, organizationId: tls.organizationId })
    .from(tls)
    .where(eq(tls.id, tlsId))
    .limit(1)
  const state = peek ? readHttpIssuanceState(peek.metadata) : null
  if (!peek || state?.endedAt !== null) return 'not_due'
  const contactEmail = await deps.contactEmail(peek.organizationId)
  const result = await deps.db.transaction((tx) =>
    advanceInTransaction(tx as unknown as Db, { deps, now, tlsId, contactEmail })
  )
  await deliverOrFail(deps, tlsId, result)
  return result.outcome
}

export type DeliveryOutcome = 'delivered' | 'not_due' | 'waiting'

/**
 * Claim the delivery of a finished pair: under the row lock, only the caller that
 * finds it unclaimed sets `deliveredAt` (and `endsSentAt`), so two sweeps never
 * push twice. Answers the ends to send, or null when it was not this caller's.
 */
async function claimDelivery(
  deps: HttpIssuanceDeps,
  tlsId: string,
  now: Date
): Promise<{
  organizationId: string
  ends: Outgoing
  requestId: string
  endsClaimed: boolean
} | null> {
  return await deps.db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const row = await lockRow(tx, tlsId)
    const state = row ? readHttpIssuanceState(row.metadata) : null
    if (!row || state?.phase !== 'issued' || state.deliveredAt !== null) return null
    const at = now.toISOString()
    await writeState(
      tx,
      row,
      { ...state, deliveredAt: at, endsSentAt: state.endsSentAt ?? at },
      now
    )
    return {
      organizationId: row.organizationId,
      requestId: state.requestId,
      ends: state.endsSentAt === null ? endMessages(now, state) : [],
      endsClaimed: state.endsSentAt === null,
    }
  })
}

/** Undo a claim whose push threw, so the next sweep tries again. */
async function releaseDelivery(
  deps: HttpIssuanceDeps,
  tlsId: string,
  requestId: string,
  endsClaimed: boolean
) {
  const now = clock(deps)
  await deps.db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const row = await lockRow(tx, tlsId)
    const state = row ? readHttpIssuanceState(row.metadata) : null
    if (!row || state?.requestId !== requestId) return
    await writeState(
      tx,
      row,
      { ...state, deliveredAt: null, ...(endsClaimed ? { endsSentAt: null } : {}) },
      now
    )
  })
}

/**
 * Hand a finished pair to the serving servers: `push` queues the certificate
 * apply for every site pinned to the row (the pair goes out sealed per server,
 * and an offline server gets it when it is back). The helpers are told to stop
 * passing the proof path on. The delivery is claimed first, under the row lock,
 * so it happens once; a push that throws releases the claim. A site the apply
 * could not reach gets the pair on its next deploy.
 */
export async function deliverIssuedPair(
  deps: HttpIssuanceDeps,
  tlsId: string,
  push: ((tlsId: string, organizationId: string) => Promise<void>) | null
): Promise<DeliveryOutcome> {
  if (!push) {
    const [peek] = await deps.db
      .select({ metadata: tls.metadata })
      .from(tls)
      .where(eq(tls.id, tlsId))
      .limit(1)
    const state = peek ? readHttpIssuanceState(peek.metadata) : null
    return state?.phase === 'issued' && state.deliveredAt === null ? 'waiting' : 'not_due'
  }
  const claim = await claimDelivery(deps, tlsId, clock(deps))
  if (!claim) return 'not_due'
  try {
    await push(tlsId, claim.organizationId)
  } catch (err) {
    await releaseDelivery(deps, tlsId, claim.requestId, claim.endsClaimed)
    throw err
  }
  await sendAll(deps, claim.ends)
  return 'delivered'
}

/**
 * Tell the helpers of a request that ended without a delivery (the issuing server
 * reported a failure) to stop passing the proof path on. Claimed under the row
 * lock, so it is sent once.
 */
export async function sendPendingEnds(deps: HttpIssuanceDeps, tlsId: string): Promise<boolean> {
  const now = clock(deps)
  const ends = await deps.db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const row = await lockRow(tx, tlsId)
    const state = row ? readHttpIssuanceState(row.metadata) : null
    if (!row || !state?.endedAt || state.endsSentAt !== null) return []
    await writeState(tx, row, { ...state, endsSentAt: now.toISOString() }, now)
    return endMessages(now, state)
  })
  await sendAll(deps, ends)
  return ends.length > 0
}

export type ReplaceKeyResult =
  | { ok: true; started: StartOutcome; leftThisWeek: number }
  | {
      ok: false
      reason: ReplaceKeyRefusal | 'cannot_start'
      leftThisWeek: number
      notBefore?: Date
    }

/**
 * "Replace Key": a fresh order for the same names with a new key (each order
 * makes one), issued by an online server and delivered only to the servers that
 * serve the name now. The old certificate keeps serving until the new pair is
 * installed. Offered at most once a day and counted against the authority's 5 a
 * week for one name set.
 */
export async function replaceKey(deps: HttpIssuanceDeps, tlsId: string): Promise<ReplaceKeyResult> {
  const now = clock(deps)
  const [row] = await deps.db
    .select({ metadata: tls.metadata, hasKey: sql<boolean>`${tls.privateKeyPem} is not null` })
    .from(tls)
    .where(eq(tls.id, tlsId))
    .limit(1)
  const state = row ? readHttpIssuanceState(row.metadata) : null
  const verdict = mayReplaceKey(state, row?.hasKey === true, now)
  if (!verdict.ok) return verdict
  const started = await startHttpIssuance(deps, tlsId, () => true)
  const running = started === 'started' || started === 'ordering'
  return running
    ? { ok: true, started, leftThisWeek: verdict.leftThisWeek }
    : { ok: false, reason: 'cannot_start', leftThisWeek: verdict.leftThisWeek }
}
