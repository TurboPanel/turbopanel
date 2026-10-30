/**
 * DNS-validated certificates: a library certificate this panel orders itself,
 * proving control of a name by publishing a TXT record through the account
 * that hosts its DNS. It covers exact names or, when the person asks, a
 * wildcard. The row is an ordinary library certificate (source `upload`, the
 * pair stored sealed) marked `acme.managedBy = 'panel'`, so sites pin it like
 * any other and nothing about delivery changes.
 *
 * An order advances one small step at a time (see `steps.ts`), driven by the
 * person's "check now" and by the periodic sweep. Failures wait: an authority
 * refusal because of rate limits is waited out, other failures back off, and a
 * first certificate gives up after three failed orders.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import { tls } from '../../../db/schema.ts'
import { AcmeError } from '../../../lib/acme/client.ts'
import { generateCertificateKey } from '../../../lib/acme/csr.ts'
import { renewalCertId } from '../../../lib/acme/renewal-id.ts'
import { logWarn } from '../../../lib/logger.ts'
import { encryptSecret } from '../../../lib/secrets/data-encryption.ts'
import { coversAllHostnames } from '../../../lib/tls/match.ts'
import { metadataFromParsed, splitTlsMetadata } from '../../../lib/tls/metadata.ts'
import { parseCertificatePem } from '../../../lib/tls/parse.ts'
import { lockOrganizationLetsEncrypt } from '../unused-letsencrypt.ts'
import { countThrottle } from '../../../lib/throttle-counters.ts'
import { TunnelProviderError } from '../../tunnels/errors.ts'
import { acmePausedUntil, pauseAcme, safeTimestamp } from './account.ts'
import {
  CLAIM_MS,
  clock,
  type DnsCertContext,
  DAY_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  MAX_NEW_PER_DAY,
  ORDER_TIMEOUT_MS,
  RECORD_KEEP_MS,
} from './context.ts'
import { plainFailure } from './messages.ts'
import {
  type DnsCertState,
  isPanelManagedAcme,
  readDnsCertState,
  type ZoneRef,
  withDnsCertState,
} from './order-state.ts'
import {
  answerChallenges,
  checkValidation,
  cleanRecords,
  leftoverRecords,
  collectCertificate,
  openOrder,
  type OrderRow,
  type StepResult,
  timedOutError,
} from './steps.ts'
import { ariDue, fallbackRenewAt, refreshedRenewAt } from './timing.ts'
import { findCarrier } from '../../tunnels/records.ts'
import { openDnsToken } from './token.ts'

type TlsRow = typeof tls.$inferSelect

/** Steps run back to back while the authority is already ready, never more than this. */
const MAX_STEPS_PER_CALL = 3

export type StartInput = {
  organizationId: string
  carrierId: string
  /** Exact names and wildcards such as `*.example.com`, already checked. */
  names: string[]
  zones: ZoneRef[]
  staging: boolean
}

export type StartResult =
  { kind: 'reused' | 'existing' | 'created'; id: string } | { kind: 'limit' }

function isoOrNull(value: string | null): number | null {
  const at = value === null ? Number.NaN : Date.parse(value)
  return Number.isNaN(at) ? null : at
}

function byCodePoint(x: string, y: string): number {
  if (x < y) return -1
  return x > y ? 1 : 0
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort(byCodePoint)
  const right = [...b].sort(byCodePoint)
  return left.length === right.length && left.every((name, i) => name === right[i])
}

function dnsNamesOf(row: TlsRow): string[] {
  const names = (row.metadata as { dnsNames?: unknown } | null)?.dnsNames
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
}

async function managedRows(db: Db, organizationId: string): Promise<TlsRow[]> {
  const rows = await db
    .select()
    .from(tls)
    .where(and(eq(tls.organizationId, organizationId), eq(tls.source, 'upload')))
  return rows.filter((row) => isPanelManagedAcme(row.metadata))
}

function acmeOf(row: TlsRow): { staging: boolean; stage: string | null } {
  const acme = (row.metadata as { acme?: { staging?: unknown; stage?: unknown } } | null)?.acme
  return {
    staging: acme?.staging === true,
    stage: typeof acme?.stage === 'string' ? acme.stage : null,
  }
}

/** When this certificate is due to be renewed: the stored time, or a third of the lifetime before the end. */
export function renewAtOf(row: TlsRow): number {
  const state = readDnsCertState(row.metadata)
  const stored = isoOrNull(state?.renewAt ?? null)
  if (stored !== null) return stored
  const notBefore = (row.metadata as { notBefore?: unknown } | null)?.notBefore
  const from = typeof notBefore === 'string' ? Date.parse(notBefore) : Number.NaN
  const to = row.notAfter ? Date.parse(row.notAfter) : Number.NaN
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.NEGATIVE_INFINITY
  return fallbackRenewAt(new Date(from), new Date(to)).getTime()
}

function findReusable(rows: TlsRow[], input: StartInput, now: Date): TlsRow | undefined {
  return rows.find(
    (row) =>
      row.status === 'ready' &&
      acmeOf(row).staging === input.staging &&
      renewAtOf(row) > now.getTime() &&
      coversAllHostnames(dnsNamesOf(row), input.names)
  )
}

function findInFlight(rows: TlsRow[], input: StartInput): TlsRow | undefined {
  return rows.find(
    (row) =>
      row.status === 'pending' &&
      acmeOf(row).staging === input.staging &&
      sameNames(dnsNamesOf(row), input.names)
  )
}

function rowName(names: readonly string[], staging: boolean): string {
  const first = (names[0] ?? 'certificate').replace(/^\*\./, '')
  const label = names.some((n) => n.startsWith('*.')) ? `${first} wildcard` : first
  const prefix = staging ? 'Test Certificate DNS' : 'DNS'
  return `${prefix} ${label}`.replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 120)
}

function emptyState(input: StartInput): DnsCertState {
  return {
    carrierId: input.carrierId,
    zones: input.zones,
    staging: input.staging,
    attempts: 0,
    nextAttemptAt: null,
    claimUntil: null,
    order: null,
    records: [],
    renewAt: null,
    ariCheckedAt: null,
    ariNextCheckAt: null,
  }
}

function publicMarker(input: { staging: boolean }, stage: string, extra: object = {}) {
  return {
    challengeType: 'dns-01' as const,
    managedBy: 'panel' as const,
    createdFor: 'library' as const,
    stage,
    staging: input.staging,
    ...extra,
  }
}

const EPOCH = new Date(0).toISOString()

async function insertRow(ctx: DnsCertContext, input: StartInput): Promise<string> {
  const key = await generateCertificateKey()
  const sealedKey = await encryptSecret(ctx.secrets, key.privateKeyPem)
  const state = emptyState(input)
  const metadata = withDnsCertState(
    {
      dnsNames: input.names,
      hasWildcard: input.names.some((n) => n.startsWith('*.')),
      notBefore: EPOCH,
      subject: '',
      issuer: '',
      acme: publicMarker(input, 'queued', { attempts: 0 }),
    },
    state
  )
  const [row] = await ctx.db
    .insert(tls)
    .values({
      organizationId: input.organizationId,
      name: rowName(input.names, input.staging),
      source: 'upload',
      certificatePem: null,
      privateKeyPem: sealedKey,
      status: 'pending',
      notAfter: EPOCH,
      fingerprintSha256: null,
      metadata,
      options: { autoRenew: true, requestedHostnames: input.names },
    })
    .returning({ id: tls.id })
  if (!row) throw new Error('The certificate row was not created')
  return row.id
}

/**
 * Find a certificate that already covers the names, an order already running
 * for them, or make a new row. The per-organization lock keeps two requests
 * at once from making two rows.
 */
export async function startDnsCertificate(
  ctx: DnsCertContext,
  input: StartInput
): Promise<StartResult> {
  const now = clock(ctx)
  return await ctx.db.transaction(async (tx) => {
    await lockOrganizationLetsEncrypt(tx, input.organizationId)
    const scoped: DnsCertContext = { ...ctx, db: tx }
    const rows = await managedRows(tx, input.organizationId)
    const reusable = findReusable(rows, input, now)
    if (reusable) return { kind: 'reused' as const, id: reusable.id }
    const inFlight = findInFlight(rows, input)
    if (inFlight) return { kind: 'existing' as const, id: inFlight.id }
    const since = now.getTime() - DAY_MS
    const recent = rows.filter((row) => Date.parse(row.createdAt) > since).length
    if (recent >= MAX_NEW_PER_DAY) return { kind: 'limit' as const }
    return { kind: 'created' as const, id: await insertRow(scoped, input) }
  })
}

function rowForSteps(row: TlsRow): OrderRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    names: dnsNamesOf(row),
    sealedKey: row.privateKeyPem,
    // A renewal tells the authority which certificate it replaces, so it is recognised as one.
    replaces:
      row.status === 'ready' && row.certificatePem ? renewalCertId(row.certificatePem) : null,
  }
}

type PublicNotes = { stage: string; lastError?: string | null; warning?: string | null }

/** What the public row shows: `undefined` keeps the earlier text, `null` clears it. */
function publicAcme(row: TlsRow, state: DnsCertState, notes: PublicNotes) {
  const previous = (row.metadata as { acme?: Record<string, unknown> } | null)?.acme ?? {}
  const { lastError, warning, nextAttemptAt: _next, renewAt: _renew, ...kept } = previous
  const error = notes.lastError === undefined ? lastError : notes.lastError
  const caution = notes.warning === undefined ? warning : notes.warning
  return {
    ...kept,
    challengeType: 'dns-01' as const,
    managedBy: 'panel' as const,
    stage: notes.stage,
    attempts: state.attempts,
    ...(state.nextAttemptAt ? { nextAttemptAt: state.nextAttemptAt } : {}),
    ...(state.renewAt ? { renewAt: state.renewAt } : {}),
    ...(typeof error === 'string' && error ? { lastError: error } : {}),
    ...(typeof caution === 'string' && caution ? { warning: caution } : {}),
  }
}

async function writeState(
  ctx: DnsCertContext,
  row: TlsRow,
  state: DnsCertState,
  notes: PublicNotes,
  extra: Partial<typeof tls.$inferInsert> = {}
): Promise<void> {
  const base = withDnsCertState(row.metadata, { ...state, claimUntil: null })
  const metadata = { ...base, acme: publicAcme(row, state, notes) }
  await ctx.db
    .update(tls)
    .set({ metadata, ...extra })
    .where(eq(tls.id, row.id))
}

/** The claim end on a row, as a time; an unreadable one counts as no claim. */
function claimedUntil() {
  return safeTimestamp(sql`${tls.metadata} #>> '{dnsCert,claimUntil}'`)
}

async function claim(ctx: DnsCertContext, id: string): Promise<TlsRow | null> {
  const now = clock(ctx)
  const until = new Date(now.getTime() + CLAIM_MS).toISOString()
  const [row] = await ctx.db
    .update(tls)
    .set({
      metadata: sql`jsonb_set(${tls.metadata}, '{dnsCert,claimUntil}', to_jsonb(${until}::text))`,
    })
    .where(
      and(
        eq(tls.id, id),
        eq(tls.source, 'upload'),
        sql`${tls.metadata} #>> '{acme,managedBy}' = 'panel'`,
        sql`${claimedUntil()} < ${now.toISOString()}::timestamptz`
      )
    )
    .returning()
  return row ?? null
}

/** Push the claim out again, so a slow step cannot let a second worker in. */
async function extendClaim(ctx: DnsCertContext, id: string): Promise<void> {
  const until = new Date(clock(ctx).getTime() + CLAIM_MS).toISOString()
  await ctx.db
    .update(tls)
    .set({
      metadata: sql`jsonb_set(${tls.metadata}, '{dnsCert,claimUntil}', to_jsonb(${until}::text))`,
    })
    .where(eq(tls.id, id))
}

async function release(ctx: DnsCertContext, id: string): Promise<void> {
  await ctx.db
    .update(tls)
    .set({ metadata: sql`jsonb_set(${tls.metadata}, '{dnsCert,claimUntil}', 'null'::jsonb)` })
    .where(eq(tls.id, id))
}

/** A renewal signs with a new key, kept sealed until the new certificate arrives. */
async function renewalKey(
  ctx: DnsCertContext,
  row: TlsRow
): Promise<{ pendingKey: string } | null> {
  if (row.status !== 'ready') return null
  const key = await generateCertificateKey()
  return { pendingKey: await encryptSecret(ctx.secrets, key.privateKeyPem) }
}

async function step(ctx: DnsCertContext, row: TlsRow, state: DnsCertState): Promise<StepResult> {
  const steps = rowForSteps(row)
  const order = state.order
  if (!order) return await openOrder(ctx, steps, state, await renewalKey(ctx, row))
  if (order.finalizedAt) return await collectCertificate(ctx, state, order)
  if (order.answeredAt) return await checkValidation(ctx, steps, state, order)
  return await answerChallenges(ctx, steps, state, order)
}

/** Has the authority asked this organization to wait, and is that wait still running? */
async function accountPaused(ctx: DnsCertContext, row: TlsRow, state: DnsCertState) {
  const until = await acmePausedUntil(ctx, row.organizationId, state.staging)
  return until !== null && until > clock(ctx).getTime()
}

/** Count a 429 or 503 by who sent it. */
function countAnswer(ctx: DnsCertContext, err: unknown): void {
  if (err instanceof AcmeError) countThrottle(ctx.counters, 'authority', err.status)
  else if (err instanceof TunnelProviderError) countThrottle(ctx.counters, 'cloudflare', err.status)
}

/** How long the authority or the DNS host asked callers to wait, or null when this was not that kind of answer. */
function throttleWaitOf(err: unknown): number | null {
  if (err instanceof AcmeError || err instanceof TunnelProviderError) return err.retryAfterMs
  return null
}

/**
 * The authority (or the DNS host) said "slow down" and for how long. That is
 * not a failed order: nothing is cleaned up, the open order and its progress
 * stay, no attempt is counted, and the row waits as long as it was told. An
 * authority answer also pauses every other order of the organization.
 */
async function holdOrder(
  ctx: DnsCertContext,
  row: TlsRow,
  state: DnsCertState,
  err: unknown,
  waitMs: number
): Promise<void> {
  const until = new Date(clock(ctx).getTime() + waitMs)
  const kept = new Set(state.records.map((r) => r.recordId))
  const left = leftoverRecords(err).filter((r) => !kept.has(r.recordId))
  if (err instanceof AcmeError) await pauseAcme(ctx, row.organizationId, state.staging, until)
  logWarn('tls', `dns certificate order ${row.id} paused until ${until.toISOString()}`)
  const next: DnsCertState = {
    ...state,
    records: [...state.records, ...left],
    nextAttemptAt: until.toISOString(),
  }
  await writeState(ctx, row, next, { stage: 'backoff', lastError: plainFailure(err) })
}

function backoffFor(err: unknown, attempts: number, now: Date): string {
  const wait =
    err instanceof AcmeError && err.retryAfterMs !== null
      ? err.retryAfterMs
      : Math.min(2 ** (attempts - 1) * 3_600_000, MAX_BACKOFF_MS)
  return new Date(now.getTime() + wait).toISOString()
}

/** The order failed: clean up its records, remember why, and wait before another try. */
async function failOrder(
  ctx: DnsCertContext,
  row: TlsRow,
  state: DnsCertState,
  err: unknown
): Promise<void> {
  const now = clock(ctx)
  const kept = new Set(state.records.map((r) => r.recordId))
  const left = leftoverRecords(err).filter((r) => !kept.has(r.recordId))
  const cleaned = await cleanRecords(ctx, rowForSteps(row), {
    ...state,
    records: [...state.records, ...left],
  })
  const attempts = state.attempts + 1
  const message = plainFailure(err)
  const renewal = row.status === 'ready'
  const rateLimited = err instanceof AcmeError && err.code === 'rate_limited'
  const giveUp = !renewal && attempts >= MAX_ATTEMPTS && !rateLimited
  const next: DnsCertState = {
    ...cleaned,
    attempts,
    nextAttemptAt: giveUp ? null : backoffFor(err, attempts, now),
    order: null,
  }
  logWarn('tls', `dns certificate order ${row.id} failed: ${message}`)
  await writeState(
    ctx,
    row,
    next,
    { stage: giveUp ? 'failed' : 'backoff', lastError: message },
    giveUp ? { status: 'failed' } : {}
  )
}

/** The certificate arrived: store the pair, take the records away, tell the sites. */
async function completeOrder(
  ctx: DnsCertContext,
  row: TlsRow,
  state: DnsCertState,
  chainPem: string
): Promise<void> {
  const order = state.order
  const parsed = await parseCertificatePem(chainPem)
  const metadata = metadataFromParsed(parsed, 'ready')
  const { columns } = splitTlsMetadata(metadata)
  const now = clock(ctx)
  const cleaned = await cleanRecords(ctx, rowForSteps(row), state)
  const timing = await refreshedRenewAt(ctx, state, {
    pem: chainPem,
    notBefore: parsed.notBefore,
    notAfter: parsed.notAfter,
  })
  const next: DnsCertState = {
    ...cleaned,
    attempts: 0,
    nextAttemptAt: null,
    order: null,
    renewAt: timing.renewAt,
    ariCheckedAt: now.toISOString(),
    ariNextCheckAt: timing.nextCheckAt,
  }
  const base = withDnsCertState(row.metadata, { ...next, claimUntil: null })
  const acme = {
    ...publicAcme(row, next, { stage: 'issued', lastError: null }),
    lastIssuedAt: now.toISOString(),
    notAfter: metadata.notAfter,
  }
  await ctx.db
    .update(tls)
    .set({
      certificatePem: chainPem,
      privateKeyPem: order?.pendingKey ?? row.privateKeyPem,
      status: columns.status,
      notAfter: columns.notAfter,
      fingerprintSha256: columns.fingerprintSha256,
      metadata: {
        ...base,
        dnsNames: metadata.dnsNames,
        hasWildcard: metadata.hasWildcard,
        notBefore: metadata.notBefore,
        subject: metadata.subject,
        issuer: metadata.issuer,
        acme,
      },
    })
    .where(eq(tls.id, row.id))
  if (order?.renewal && ctx.onRenewed) {
    await ctx
      .onRenewed(row.id, row.organizationId)
      .catch((err) =>
        logWarn(
          'tls',
          `renewed certificate ${row.id} was not refreshed on its sites: ${String(err)}`
        )
      )
  }
}

export type AdvanceOutcome = 'busy' | 'waiting' | 'issued' | 'failed' | 'backoff' | 'not_found'

function stageOf(state: DnsCertState): string {
  const order = state.order
  if (!order) return 'queued'
  if (order.finalizedAt) return 'finalizing'
  return order.answeredAt ? 'validating' : 'presented'
}

function orderTimedOut(ctx: DnsCertContext, state: DnsCertState): boolean {
  const started = state.order ? Date.parse(state.order.startedAt) : Number.NaN
  return !Number.isNaN(started) && clock(ctx).getTime() - started > ORDER_TIMEOUT_MS
}

/** Why a row has nothing to do right now, or null when a step is due. */
function notDue(ctx: DnsCertContext, row: TlsRow, state: DnsCertState): AdvanceOutcome | null {
  if (row.status === 'failed' || row.status === 'revoked') return 'failed'
  const now = clock(ctx).getTime()
  const wait = isoOrNull(state.nextAttemptAt)
  if (wait !== null && wait > now) return 'backoff'
  const idleRenewal = row.status === 'ready' && !state.order
  return idleRenewal && renewAtOf(row) > now ? 'waiting' : null
}

/**
 * Run the next step or two of a certificate's order. Safe to call from a
 * request and from the sweep at once: one of them takes the row, the other
 * answers `busy`.
 */
export async function advanceDnsCertificate(
  ctx: DnsCertContext,
  id: string
): Promise<AdvanceOutcome> {
  const row = await claim(ctx, id)
  if (!row) return 'busy'
  let state = readDnsCertState(row.metadata)
  if (!state) {
    await release(ctx, row.id)
    return 'not_found'
  }
  const early = notDue(ctx, row, state)
  if (early) {
    await writeState(ctx, row, state, { stage: acmeOf(row).stage ?? 'issued' })
    return early
  }
  if (await accountPaused(ctx, row, state)) {
    await release(ctx, row.id)
    return 'backoff'
  }
  try {
    if (orderTimedOut(ctx, state)) throw await timedOutError(ctx, state, state.order)
    for (let i = 0; i < MAX_STEPS_PER_CALL; i += 1) {
      if (i > 0) await extendClaim(ctx, row.id)
      const result = await step(ctx, row, state)
      state = result.state
      if (result.kind === 'issued') {
        await completeOrder(ctx, row, state, result.chainPem)
        return 'issued'
      }
      if (result.kind === 'wait') break
    }
    await writeState(ctx, row, state, { stage: stageOf(state) })
    return 'waiting'
  } catch (err) {
    countAnswer(ctx, err)
    const wait = throttleWaitOf(err)
    if (wait !== null) {
      await holdOrder(ctx, row, state, err, wait)
      return 'backoff'
    }
    await failOrder(ctx, row, state, err)
    return 'failed'
  }
}

/** A person's "try again" on a certificate that gave up: only after a quiet quarter hour. */
export async function retryDnsCertificate(
  ctx: DnsCertContext,
  id: string
): Promise<'retried' | 'too_soon' | 'not_failed' | 'not_found'> {
  const row = await claim(ctx, id)
  if (!row) return 'not_found'
  const state = readDnsCertState(row.metadata)
  if (!state) {
    await release(ctx, row.id)
    return 'not_found'
  }
  if (row.status !== 'failed') {
    await release(ctx, row.id)
    return 'not_failed'
  }
  if (clock(ctx).getTime() - Date.parse(row.updatedAt) < 15 * 60_000) {
    await release(ctx, row.id)
    return 'too_soon'
  }
  const fresh: DnsCertState = { ...state, attempts: 0, nextAttemptAt: null, order: null }
  await writeState(ctx, row, fresh, { stage: 'queued', lastError: null }, { status: 'pending' })
  return 'retried'
}

/** Why the next renewal cannot work, in plain words, or null when it can. */
async function renewalBlocker(
  ctx: DnsCertContext,
  row: TlsRow,
  state: DnsCertState
): Promise<string | null> {
  const due = new Date(renewAtOf(row)).toISOString().slice(0, 10)
  const carrier = await findCarrier(ctx.db, row.organizationId, state.carrierId)
  if (!carrier) {
    return `The account this certificate was ordered through was removed. Connect it again before ${due}, or the certificate will not renew.`
  }
  const checks = await Promise.all(
    state.zones.map(async (zone) => ({
      zone,
      token: await openDnsToken(ctx, carrier.id, { zone }),
    }))
  )
  const missing = checks.find((c) => c.token === null)
  return missing
    ? `No token on ${carrier.name} can edit DNS for ${missing.zone.name} any more. Add one before ${due}, or the certificate will not renew.`
    : null
}

/**
 * Housekeeping for one certificate, done between orders: records left behind
 * (by an interrupted request) are removed by id once they are old enough, the
 * renewal time follows the authority's advice, and a renewal that cannot work
 * is flagged on the certificate long before it matters.
 */
export async function maintainDnsCertificate(ctx: DnsCertContext, id: string): Promise<boolean> {
  const row = await claim(ctx, id)
  if (!row) return false
  let state = readDnsCertState(row.metadata)
  if (!state) {
    await release(ctx, row.id)
    return false
  }
  const now = clock(ctx)
  const isStale = (r: { createdAt: string }) =>
    now.getTime() - Date.parse(r.createdAt) > RECORD_KEEP_MS
  const stale = state.records.filter(isStale)
  if (stale.length > 0 && !state.order) {
    // Only the old ones: a record of an order that is still being checked stays.
    const cleaned = await cleanRecords(ctx, rowForSteps(row), { ...state, records: stale })
    state = { ...state, records: [...state.records.filter((r) => !isStale(r)), ...cleaned.records] }
  }
  const idle = row.status === 'ready' && !state.order
  if (idle && ariDue(ctx, state) && row.certificatePem && !(await accountPaused(ctx, row, state))) {
    const notBefore = (row.metadata as { notBefore?: string } | null)?.notBefore
    const timing = await refreshedRenewAt(
      ctx,
      state,
      {
        pem: row.certificatePem,
        notBefore: new Date(notBefore ?? row.createdAt),
        notAfter: new Date(row.notAfter ?? row.createdAt),
      },
      { keep: state.renewAt }
    )
    state = {
      ...state,
      ariCheckedAt: now.toISOString(),
      ariNextCheckAt: timing.nextCheckAt,
      renewAt: timing.renewAt,
    }
  }
  const warning = idle ? await renewalBlocker(ctx, row, state) : null
  const current = (row.metadata as { acme?: { warning?: unknown } } | null)?.acme?.warning
  const changed = (warning ?? undefined) !== (typeof current === 'string' ? current : undefined)
  await writeState(ctx, row, state, {
    stage: acmeOf(row).stage ?? 'issued',
    ...(changed || idle ? { warning } : {}),
  })
  return changed
}
