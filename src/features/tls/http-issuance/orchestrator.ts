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
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import {
  deployment,
  environment,
  hosting,
  organization,
  server,
  service,
  tls,
} from '../../../db/schema.ts'
import {
  parseOrganizationOptions,
  resolveAcmeEnabled,
} from '../../organizations/organization-options.ts'
import type { DaemonOutboundEnvelope } from '../../../contracts/cell-protocol.ts'
import { generateDeliveryId, generateRequestId } from '../../../contracts/cell-protocol.ts'
import { loadServerPublicAddresses } from '../../net/client-addresses.ts'
import { ACME_ISSUE_FEATURE } from '../../../lib/version-wire.ts'
import { forEachSequential } from '../../../lib/sequential.ts'
import { type DnsLookup, resolveNameAddresses } from '../../hostings/hosting-dns-check.ts'
import type { TlsAcmeMetadata } from '../../../lib/tls/types.ts'
import { mayStartAttempt, pruneAttempts } from './attempts.ts'
import { type Choice, chooseParticipants, type ServingServer } from './choose.ts'
import {
  applyForwardReports,
  decideOpen,
  type ForwardReport,
  mayReplaceKey,
  failedState,
  publicMarker,
  REQUEST_LIFETIME_MS,
  type ReplaceKeyRefusal,
  waitingMarker,
} from './progress.ts'
import {
  closedAsIssued,
  type ForwardResult,
  type HttpIssuanceState,
  newHttpIssuanceState,
  readHttpIssuanceState,
  type RosterEntry,
  withHttpIssuanceState,
} from './state.ts'
import { waitingText } from './status-text.ts'

export type HttpIssuanceDeps = {
  db: Db
  now?: () => Date
  /** Puts one envelope in the server's cell outbox. */
  send: (serverId: string, envelope: DaemonOutboundEnvelope) => Promise<void>
  dnsLookup: DnsLookup
  isOnline: (serverId: string) => Promise<boolean>
  daemonFeatures: (serverId: string) => Promise<readonly string[]>
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
  names: string[]
  hasPair: boolean
  metadata: Record<string, unknown>
}

function namesOf(metadata: unknown): string[] {
  const names = (metadata as { dnsNames?: unknown } | null)?.dnsNames
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
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
    hasPair: row.hasKey === true,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }
}

/** The organization's Let's Encrypt switch, read under the row lock. */
async function acmeEnabledFor(tx: Db, organizationId: string): Promise<boolean> {
  const [org] = await tx
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return resolveAcmeEnabled(parseOrganizationOptions(org?.options))
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

async function writeWaiting(tx: Db, row: RowFacts, text: string, now: Date): Promise<void> {
  const previous = row.metadata.acme as TlsAcmeMetadata | undefined
  // The same words again: leave the row alone, so a waiting row is not rewritten every minute.
  if (previous?.stage === 'waiting' && previous.warning === text) return
  const acme = waitingMarker(previous, text)
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
    .where(eq(hosting.tlsId, tlsId))
  const deployed = await db
    .select({ serverId: deployment.serverId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(deployment, eq(deployment.environmentId, service.environmentId))
    .where(and(eq(hosting.tlsId, tlsId), ne(deployment.status, 'draining')))
  const ids = [...new Set([...own, ...deployed].flatMap((r) => r.serverId ?? []))]
  if (ids.length === 0) return []
  const names = await db
    .select({ id: server.id, name: server.name })
    .from(server)
    .where(inArray(server.id, ids))
  const label = new Map(names.map((n) => [n.id, n.name ?? 'A server']))
  return ids.map((serverId) => ({ serverId, label: label.get(serverId) ?? 'A server' }))
}

async function describeServers(
  deps: HttpIssuanceDeps,
  rows: ServingRow[]
): Promise<ServingServer[]> {
  return await Promise.all(
    rows.map(async (r) => {
      const [online, features, addresses] = await Promise.all([
        deps.isOnline(r.serverId),
        deps.daemonFeatures(r.serverId),
        loadServerPublicAddresses(deps.db, r.serverId),
      ])
      return {
        serverId: r.serverId,
        label: r.label,
        online,
        hasFeature: features.includes(ACME_ISSUE_FEATURE),
        addresses,
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

async function sendAll(
  deps: HttpIssuanceDeps,
  items: Array<{ serverId: string; envelope: DaemonOutboundEnvelope }>
): Promise<string[]> {
  const failed: string[] = []
  await forEachSequential(items, async (item) => {
    try {
      await deps.send(item.serverId, item.envelope)
    } catch {
      failed.push(item.serverId)
    }
  })
  return failed
}

function orderEnvelope(
  now: Date,
  row: Pick<RowFacts, 'id' | 'names'>,
  state: HttpIssuanceState,
  helpers: Array<{ serverId: string; address: string }>,
  contactEmail: string
): DaemonOutboundEnvelope {
  return envelope(now, 'acme-issue-request', {
    acmeRequestId: state.requestId,
    tlsId: row.id,
    names: row.names,
    directory: state.directory,
    contactEmail,
    startByIso: state.startByAt,
    helpers,
  })
}

/**
 * Whether a row may be ordered centrally at all: exactly one plain name. A
 * wildcard needs the DNS proof, and a row with several names (apex and www)
 * would get one certificate per name from the daemon, which the panel cannot
 * yet store or send as one pin; such a row stays with each server's own web
 * server and is never touched here.
 */
export function isHttpOrderable(names: readonly string[]): boolean {
  return names.length === 1 && !names[0].includes('*')
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
  row: Pick<RowFacts, 'id' | 'names'>,
  previous: HttpIssuanceState | null
): Promise<{ choice: Choice; servers: ServingServer[] }> {
  const servers = await describeServers(deps, await loadServingServers(deps.db, row.id))
  // Nothing to choose from until the first pass over the servers: skip the DNS lookup.
  if (!servers.some((s) => s.hasFeature)) {
    return { choice: { ok: false, reason: 'no_servers', skipped: [] }, servers }
  }
  const dnsAddresses = await dnsAddressesOf(deps.dnsLookup, row.names)
  const choice = chooseParticipants({
    servers,
    dnsAddresses,
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
}): HttpIssuanceState {
  const { deps, now, choice, previous } = params
  const startedAt = now.toISOString()
  return newHttpIssuanceState({
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
      names: row.names,
      targetAddress: choice.issuerAddress,
      expiresAtIso: state.startByAt,
    }),
  }))
}

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

async function startInTransaction(
  tx: Db,
  params: {
    deps: HttpIssuanceDeps
    now: Date
    tlsId: string
    choice: Choice
    contactEmail: string
    due: (facts: { hasPair: boolean; metadata: Record<string, unknown> }) => boolean
  }
): Promise<StepResult> {
  const { deps, now, choice, contactEmail } = params
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
  if (!verdict.ok) return { outcome: 'backoff', send: [] }
  if (!choice.ok) {
    await writeWaiting(tx, row, waitingText(choice.reason), now)
    return { outcome: 'waiting', send: [] }
  }
  // One order at a time per issuing server: the daemon runs one window at a time, so a
  // second order would only wait behind the first and could pass the silence limit.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${choice.issuer.serverId}))`)
  if (await issuerHasOpenOrder(tx, choice.issuer.serverId)) return { outcome: 'busy', send: [] }
  const fresh = freshState({ deps, now, choice, previous, staging: deps.staging })
  const direct = choice.helpers.length === 0
  const state: HttpIssuanceState = direct
    ? { ...fresh, phase: 'ordering', orderSentAt: fresh.startedAt }
    : fresh
  await writeState(tx, row, state, now)
  return {
    outcome: direct ? 'ordering' : 'started',
    send: openingMessages(now, row, state, choice, contactEmail),
    state,
  }
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
  const names = namesOf(peek.metadata)
  if (!isHttpOrderable(names)) return 'not_eligible'
  const previous = readHttpIssuanceState(peek.metadata)
  if (previous?.endedAt === null) return 'not_due'
  // The cheap answers first: nothing to do, a wait or a cap in force, no contact
  // address. None of them looks at DNS or at the servers.
  const meta = (peek.metadata ?? {}) as Record<string, unknown>
  if (!due({ hasPair: peek.hasKey === true, metadata: meta })) return 'not_due'
  const attempts = {
    attemptTimes: previous?.attemptTimes ?? [],
    nextAttemptAt: previous?.nextAttemptAt ?? null,
  }
  if (!mayStartAttempt(attempts, now).ok) return 'backoff'
  const contactEmail = await deps.contactEmail(peek.organizationId)
  if (contactEmail === null || contactEmail.trim() === '') {
    return await waitForContact(deps, peek.organizationId, tlsId, now)
  }
  const { choice, servers } = await gather(deps, { id: tlsId, names }, previous)
  // Every serving server on an older daemon keeps ordering for itself; the row is left alone.
  if (!servers.some((s) => s.hasFeature)) return 'not_eligible'
  const result = await deps.db.transaction((tx) =>
    startInTransaction(tx as unknown as Db, { deps, now, tlsId, choice, contactEmail, due })
  )
  await deliverOrFail(deps, tlsId, result)
  return result.outcome
}

/**
 * No contact address for the organization. Only database reads: when a serving
 * server's daemon lists the feature the row says it is waiting for an address (an
 * unchanged marker is not rewritten); otherwise it is not ours and is left alone.
 * Never looks at DNS.
 */
async function waitForContact(
  deps: HttpIssuanceDeps,
  organizationId: string,
  tlsId: string,
  now: Date
): Promise<StartOutcome> {
  const serving = await loadServingServers(deps.db, tlsId)
  const lists = await Promise.all(
    serving.map(async (s) => (await deps.daemonFeatures(s.serverId)).includes(ACME_ISSUE_FEATURE))
  )
  if (!lists.some(Boolean)) return 'not_eligible'
  await deps.db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const row = await lockRow(tx, tlsId)
    if (row?.organizationId !== organizationId) return
    await writeWaiting(tx, row, waitingText('no_contact'), now)
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
  blameIssuer: boolean
): Promise<void> {
  const now = clock(deps)
  await deps.db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    const row = await lockRow(tx, tlsId)
    const state = row ? readHttpIssuanceState(row.metadata) : null
    if (!row || state?.requestId !== requestId || state.endedAt !== null) return
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
