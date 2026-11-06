/**
 * One DNS-01 order for a control plane hostname, a step per call so the tick
 * can drive it: start (preflight, order, publish the TXT record), wait until
 * every authoritative nameserver answers it, have the authority validate,
 * then finalize, store the pair sealed and hand it to the daemon. The
 * certificate key is made and used inside the finalize step only.
 */
import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../../../../db/connection.ts'
import { instanceHostname, instanceUploadedCertificate } from '../../../../db/schema.ts'
import type { ResolvedInstanceAcmeSettings } from '../../../../features/install/instance-acme-settings.ts'
import { daemonNotLoadedError } from '../../../../features/install/instance-hostnames.ts'
import type { DnsChallengeProvider } from '../../../../features/tls/dns-certificates/dns-provider.ts'
import {
  AcmeError,
  type AcmeAuthorization,
  type AcmeClient,
  type AcmeOrder,
} from '../../../../lib/acme/client.ts'
import { buildCertificateRequest, generateCertificateKey } from '../../../../lib/acme/csr.ts'
import { logWarn } from '../../../../lib/logger.ts'
import { aboutWait, utcMoment } from '../../../../lib/plain-time.ts'
import { forEachSequential } from '../../../../lib/sequential.ts'
import { encryptSecret } from '../../../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../../../lib/secrets/secrets.ts'
import { parseCertificatePem } from '../../../../lib/tls/index.ts'
import { type IngressAccountRecord, listIngressAccounts, zoneForName } from '../accounts.ts'
import { dnsName } from '../cloudflare/tunnel-config.ts'
import { dns01Directory, forgetInstanceAcmeAccount, instanceAcmeClient } from './account.ts'
import { alertOnFailure, type Notify } from './alerts.ts'
import {
  abandonedInLastDay,
  alertsFor,
  canResume,
  cappedState,
  DNS01_MAX_STARTS_PER_HOUR,
  failureState,
  isLookupFailure,
  mapAcmeFailure,
  nextAttemptAt,
  orderCapReached,
  startsInLastHour,
} from './backoff.ts'
import {
  type DnsLookup,
  preflightDns01,
  txtNotVisibleDetail,
  txtVisibleOnAll,
} from './preflight.ts'
import { planRenewal } from './renewal.ts'
import {
  type Dns01Failure,
  type Dns01Order,
  type Dns01State,
  IDLE_STATE,
  readDns01State,
  withStage,
} from './state.ts'

/** How long the challenge record may take to reach every nameserver. */
export const TXT_WAIT_MS = 10 * 60_000
/** How long the authority may take to validate before the order is dropped. */
export const ORDER_TIMEOUT_MS = 30 * 60_000
const FINALIZE_POLLS = 5
const FINALIZE_POLL_MS = 2_000

export type Dns01Deps = {
  db: Db
  now: () => Date
  random: () => number
  fetch: typeof fetch
  dns: DnsLookup
  dataEncryption: DerivedSecretsConfig
  settings: ResolvedInstanceAcmeSettings
  /** The TXT-record writer for an account (opens its token). */
  challengeProvider: (account: IngressAccountRecord) => Promise<DnsChallengeProvider>
  notify: Notify
  /** Push the hostnames (and the new pair) to the co-located daemon; throws on failure. */
  applyToDaemon: () => Promise<void>
  sleep?: (ms: number) => Promise<void>
}

export type Dns01Row = {
  id: string
  host: string
  name: string
  ingressId: string | null
  uploadedCertId: string | null
  notAfter: string | null
  state: Dns01State
}

export async function loadDns01Row(db: Db, id: string): Promise<Dns01Row | null> {
  const rows = await db
    .select()
    .from(instanceHostname)
    .where(and(eq(instanceHostname.id, id), eq(instanceHostname.source, 'acme-dns-01')))
    .limit(1)
  const row = rows[0]
  const name = row ? dnsName(row.host) : null
  if (!row || !name) return null
  return {
    id: row.id,
    host: row.host,
    name,
    ingressId: row.ingressId,
    uploadedCertId: row.uploadedCertId,
    notAfter: row.notAfter,
    state: readDns01State(row.acmeState),
  }
}

export async function saveDns01State(
  db: Db,
  id: string,
  state: Dns01State,
  extra: Partial<typeof instanceHostname.$inferInsert> = {}
): Promise<void> {
  await db
    .update(instanceHostname)
    .set({ acmeState: state, ...extra })
    .where(eq(instanceHostname.id, id))
}

/** The hostname's own account when it has one, else the first Cloudflare account whose zones cover it. */
async function accountFor(db: Db, row: Dns01Row): Promise<IngressAccountRecord | null> {
  const accounts = (await listIngressAccounts(db)).filter(
    (account) => account.provider === 'cloudflare'
  )
  const own = accounts.find((account) => account.id === row.ingressId)
  if (own) return own
  return accounts.find((account) => zoneForName(account.scopes?.zones ?? [], row.name)) ?? null
}

async function removeRecord(
  deps: Dns01Deps,
  row: Dns01Row,
  order: Dns01Order | null
): Promise<void> {
  if (!order?.record) return
  const account = await accountFor(deps.db, row)
  if (!account) return
  const provider = await deps.challengeProvider(account)
  await provider.remove(order.record).catch(() => undefined)
}

/**
 * What a failure does with the stored order: `keep` it (and its record) for
 * the next start, `abandon` it (deactivate its authorization, count it, remove
 * the record) or `close` it (remove the record only: the authority already
 * settled the authorization, or the account that owns it is gone).
 */
export type OrderFate = 'keep' | 'abandon' | 'close'

/** An order whose challenge was never answered is abandoned; an answered one is closed. */
function defaultFate(order: Dns01Order | null): OrderFate {
  return order && !order.answeredAt ? 'abandon' : 'close'
}

/**
 * Give up an authorization this control plane will not answer (RFC 8555
 * §7.5.2), so it stops counting against the authority's pending limits. Best
 * effort: a failure is logged and changes nothing else.
 */
async function deactivate(deps: Dns01Deps, authzUrl: string): Promise<void> {
  if (!authzUrl) return
  try {
    await (await client(deps)).deactivateAuthorization(authzUrl)
  } catch (err) {
    const reason = err instanceof AcmeError ? `${err.code} ${err.status ?? ''}`.trim() : 'error'
    logWarn('dns01', `Deactivating an abandoned authorization failed (${reason}).`)
  }
}

/** Deactivate an abandoned order's authorization and return the updated abandon times. */
async function abandon(deps: Dns01Deps, state: Dns01State, authzUrl: string): Promise<string[]> {
  await deactivate(deps, authzUrl)
  const now = deps.now()
  return [...abandonedInLastDay(state.abandonedTimes, now), now.toISOString()]
}

/**
 * Back off (or stop, after too many failed orders) and tell the operator once
 * per cause. `attemptTimes` replaces the stored start times when the start
 * never reached the authority. `fate` says what happens to the stored order.
 */
export async function recordFailure(
  deps: Dns01Deps,
  row: Dns01Row,
  failure: Dns01Failure,
  stopUntil: Date | null,
  attemptTimes?: string[],
  fate: OrderFate = defaultFate(row.state.order)
): Promise<Dns01State> {
  const order = row.state.order
  const abandonedTimes =
    fate === 'abandon' && order
      ? await abandon(deps, row.state, order.authzUrl)
      : row.state.abandonedTimes
  if (fate !== 'keep') await removeRecord(deps, row, order)
  const now = deps.now()
  const failedState = failureState({ ...row.state, abandonedTimes }, failure, {
    now,
    random: deps.random,
    stopUntil,
    ...(attemptTimes ? { attemptTimes } : {}),
  })
  const failed = fate === 'keep' ? { ...failedState, order } : failedState
  const alerted = alertsFor(failed, failure)
    ? await alertOnFailure(failed, row.name, failure, failed.nextAttemptAt, deps.notify)
    : failed
  await saveDns01State(deps.db, row.id, alerted, {
    acmeLastAttemptAt: now.toISOString(),
    acmeLastError: failure.detail,
  })
  return alerted
}

async function failWith(deps: Dns01Deps, row: Dns01Row, err: unknown): Promise<Dns01State> {
  const mapped = mapAcmeFailure(err, deps.now())
  if (mapped.cause === 'account-error' && err instanceof AcmeError)
    await forgetInstanceAcmeAccount(deps.db)
  // Without a usable account its authorizations cannot be deactivated, and trying would register a new one.
  const fate = mapped.cause === 'account-error' ? 'close' : undefined
  return await recordFailure(
    deps,
    row,
    { cause: mapped.cause, detail: mapped.detail },
    mapped.stopUntil,
    undefined,
    fate
  )
}

function client(deps: Dns01Deps): Promise<AcmeClient> {
  return instanceAcmeClient(deps.db, {
    dataEncryption: deps.dataEncryption,
    fetch: deps.fetch,
    settings: deps.settings,
  })
}

/** Read the new order's challenge and publish its record. */
async function publishChallenge(
  deps: Dns01Deps,
  acme: AcmeClient,
  row: Dns01Row,
  provider: DnsChallengeProvider,
  order: AcmeOrder,
  zoneId: string,
  nameservers: string[]
): Promise<Dns01Order> {
  const authz = await acme.getAuthorization(order.authorizations[0] ?? '')
  const challenge = authz.challenges.find((item) => item.type === 'dns-01')
  if (!challenge)
    throw new AcmeError('server', 'The certificate authority offered no DNS-01 challenge.')
  const txtName = `_acme-challenge.${row.name}`
  const txtValue = await acme.dnsValue(challenge.token)
  const record = await provider.present({ zoneId, name: txtName, value: txtValue })
  return {
    url: order.url,
    finalizeUrl: order.finalize,
    authzUrl: authz.url,
    challengeUrl: challenge.url,
    txtName,
    txtValue,
    record,
    nameservers,
    startedAt: deps.now().toISOString(),
    answeredAt: null,
  }
}

/**
 * Whether the authority answered a read with a plain no (4xx: the
 * authorization is gone or not this account's), as opposed to an answer that
 * is unknown (no answer, a 5xx or a rate limit).
 */
function definiteRefusal(err: unknown): boolean {
  if (!(err instanceof AcmeError) || err.status === null) return false
  return err.status >= 400 && err.status < 500 && err.code !== 'rate_limited'
}

/**
 * Pick up the order kept by a lookup failure when its authorization is still
 * pending and has time left: wait for its record again instead of opening a
 * new order. Null when there is none to pick up. When the authority cannot
 * say how the authorization stands, the order stays kept for the next start:
 * only a definite answer gives it up.
 */
async function resumeKept(
  deps: Dns01Deps,
  row: Dns01Row,
  nameservers: string[],
  priorStarts: string[]
): Promise<Dns01State | null> {
  const kept = row.state.order
  if (!kept || kept.answeredAt) return null
  const acme = await client(deps)
  let authz: AcmeAuthorization | null = null
  try {
    authz = await acme.getAuthorization(kept.authzUrl)
  } catch (err) {
    // A gone account is handled by the caller's failure path (the order closes there).
    if (err instanceof AcmeError && err.code === 'account_gone') throw err
    if (!definiteRefusal(err)) return await keepAfterUnknownRead(deps, row, err, priorStarts)
  }
  if (!authz || !canResume(authz, deps.now())) return null
  const order = { ...kept, nameservers, startedAt: deps.now().toISOString() }
  // The lookup count stays: the record has still not been seen, so the waits keep growing.
  const state = withStage(row.state, 'waiting-dns', { order, nextAttemptAt: null })
  await saveDns01State(deps.db, row.id, state, { acmeLastAttemptAt: order.startedAt })
  return state
}

/** The kept order stays for the next start; no new order was opened, so the start budget is left alone. */
async function keepAfterUnknownRead(
  deps: Dns01Deps,
  row: Dns01Row,
  err: unknown,
  priorStarts: string[]
): Promise<Dns01State> {
  const mapped = mapAcmeFailure(err, deps.now())
  const failure = { cause: mapped.cause, detail: mapped.detail }
  return await recordFailure(deps, row, failure, mapped.stopUntil, priorStarts, 'keep')
}

/** Give up a kept order that cannot be picked up again, before a new one opens. */
async function dropKept(deps: Dns01Deps, row: Dns01Row): Promise<Dns01Row> {
  const kept = row.state.order
  if (!kept) return row
  const abandonedTimes = kept.answeredAt
    ? row.state.abandonedTimes
    : await abandon(deps, row.state, kept.authzUrl)
  await removeRecord(deps, row, kept)
  return { ...row, state: { ...row.state, order: null, abandonedTimes } }
}

/** The daily order cap holds this start: only the preflight ran, again in an hour. */
async function holdForCap(
  deps: Dns01Deps,
  row: Dns01Row,
  priorStarts: string[]
): Promise<Dns01State> {
  const now = deps.now()
  const capped = cappedState(row.state, now, priorStarts)
  const failure = { cause: 'order-cap' as const, detail: capped.lastError?.detail ?? '' }
  // Once per run, like every other cause: a name that stopped opening orders must be seen.
  const state = await alertOnFailure(capped, row.name, failure, capped.nextAttemptAt, deps.notify)
  await saveDns01State(deps.db, row.id, state, {
    acmeLastAttemptAt: now.toISOString(),
    acmeLastError: failure.detail,
  })
  return state
}

/** Open a new order and publish its record; an order that fails on the way is abandoned. */
async function openOrder(
  deps: Dns01Deps,
  row: Dns01Row,
  provider: DnsChallengeProvider,
  zoneId: string,
  nameservers: string[]
): Promise<Dns01State> {
  const acme = await client(deps)
  // A renewal names the certificate it replaces, so the authority exempts it from limits.
  const replaces = row.uploadedCertId ? row.state.replaces : null
  const opened = await acme.newOrder([row.name], replaces ? { replaces } : {})
  let order: Dns01Order
  try {
    order = await publishChallenge(deps, acme, row, provider, opened, zoneId, nameservers)
  } catch (err) {
    const abandonedTimes = await abandon(deps, row.state, opened.authorizations[0] ?? '')
    return await failWith(deps, { ...row, state: { ...row.state, abandonedTimes } }, err)
  }
  const state = withStage(row.state, 'waiting-dns', {
    order,
    nextAttemptAt: null,
    lookupFailures: 0,
  })
  await saveDns01State(deps.db, row.id, state, { acmeLastAttemptAt: order.startedAt })
  return state
}

async function startWith(
  deps: Dns01Deps,
  row: Dns01Row,
  account: IngressAccountRecord,
  priorStarts: string[]
): Promise<Dns01State> {
  const provider = await deps.challengeProvider(account)
  const checked = await preflightDns01({
    provider,
    dns: deps.dns,
    zones: account.scopes?.zones ?? [],
    host: row.name,
  })
  if (!checked.ok || !checked.zone) {
    const failure = checked.failure ?? { cause: 'provider-error', detail: 'Preflight failed.' }
    // A lookup failure asked the authority nothing, so this start does not use the hourly
    // budget, and it says nothing about a kept order, which stays for the next start.
    const lookup = isLookupFailure(failure.cause)
    const starts = lookup ? priorStarts : undefined
    return await recordFailure(deps, row, failure, null, starts, lookup ? 'keep' : undefined)
  }
  const resumed = await resumeKept(deps, row, checked.nameservers, priorStarts)
  if (resumed) return resumed
  const fresh = await dropKept(deps, row)
  try {
    if (orderCapReached(fresh.state, deps.now())) return await holdForCap(deps, fresh, priorStarts)
    return await openOrder(deps, fresh, provider, checked.zone.id, checked.nameservers)
  } catch (err) {
    // The kept order was given up above: fail on the row without it, so it is not given up twice.
    return await failWith(deps, fresh, err)
  }
}

export type StartRefusal = { ok: false; error: string }

/** Why a start must wait now, or null: the authority's pause, or the hourly start budget. */
function startRefusal(state: Dns01State, now: Date): StartRefusal | null {
  const stop = Date.parse(state.stopUntil ?? '')
  if (!Number.isNaN(stop) && stop > now.getTime()) {
    const until = new Date(stop)
    return {
      ok: false,
      error: `Retry is paused for ${aboutWait(stop - now.getTime())} (until ${utcMoment(until)}) by the certificate authority's limit.`,
    }
  }
  const recent = startsInLastHour(state.attemptTimes, now)
  if (recent.length < DNS01_MAX_STARTS_PER_HOUR) return null
  const free = nextAttemptAt(now, 0, () => 0, recent)
  return {
    ok: false,
    error: `Too many orders for this name in the last hour. Retry in ${aboutWait(free.getTime() - now.getTime())} (after ${utcMoment(free)}).`,
  }
}

/** Start an order now. Refused while the authority's limit or the hourly budget pauses the name. */
export async function startOrder(
  deps: Dns01Deps,
  row: Dns01Row
): Promise<Dns01State | StartRefusal> {
  const now = deps.now()
  const refusal = startRefusal(row.state, now)
  if (refusal) return refusal
  const priorStarts = startsInLastHour(row.state.attemptTimes, now)
  const attemptTimes = [...priorStarts, now.toISOString()]
  const started: Dns01Row = {
    ...row,
    state: withStage(row.state, 'preflight', { attemptTimes, stopUntil: null }),
  }
  const account = await accountFor(deps.db, started)
  if (!account) {
    const detail = `The zone for ${row.name} is not on a connected Cloudflare account.`
    return await recordFailure(deps, started, { cause: 'zone-not-on-provider', detail }, null)
  }
  try {
    return await startWith(deps, started, account, priorStarts)
  } catch (err) {
    return await failWith(deps, started, err)
  }
}

async function waitForDns(deps: Dns01Deps, row: Dns01Row, order: Dns01Order): Promise<Dns01State> {
  const visible = await txtVisibleOnAll(deps.dns, order.nameservers, order.txtName, order.txtValue)
  if (visible.ok) {
    await (await client(deps)).answerChallenge(order.challengeUrl)
    const answered = { ...order, answeredAt: deps.now().toISOString() }
    const state = withStage(row.state, 'validating', { order: answered })
    await saveDns01State(deps.db, row.id, state)
    return state
  }
  if (deps.now().getTime() - Date.parse(order.startedAt) < TXT_WAIT_MS) return row.state
  const detail = txtNotVisibleDetail(visible)
  // No server answered at all: this host cannot reach them, which says nothing about the record,
  // so the order and its record are kept for the next start instead of piling up new ones.
  const cause = visible.missing.length === 0 ? 'dns-lookup' : 'txt-not-visible'
  const fate = cause === 'dns-lookup' ? 'keep' : 'abandon'
  return await recordFailure(deps, row, { cause, detail }, null, undefined, fate)
}

function challengeFailure(authz: AcmeAuthorization): Dns01Failure {
  const problem = authz.challenges.find((item) => item.type === 'dns-01')?.error
  const detail = problem?.detail ?? 'The certificate authority refused the challenge.'
  const caa = problem?.type?.endsWith(':caa') === true
  return caa
    ? { cause: 'caa-forbids', detail }
    : {
        cause: 'txt-not-visible',
        detail: `The certificate authority could not see the challenge record: ${detail}`,
      }
}

async function finalizeOrder(deps: Dns01Deps, acme: AcmeClient, order: Dns01Order, name: string) {
  const key = await generateCertificateKey()
  const csr = await buildCertificateRequest({
    privateKey: key.privateKey,
    spki: key.spki,
    names: [name],
  })
  let current = { ...(await acme.finalize(order.finalizeUrl, csr)), url: order.url }
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const polls = Array.from({ length: FINALIZE_POLLS }, (_, poll) => poll)
  await forEachSequential(polls, async () => {
    if (current.status !== 'processing') return
    await sleep(FINALIZE_POLL_MS)
    current = await acme.getOrder(order.url)
  })
  if (current.status !== 'valid' || !current.certificate) {
    throw new AcmeError(
      'server',
      'The certificate authority did not finish the certificate in time.'
    )
  }
  return { certPem: await acme.downloadCertificate(current.certificate), keyPem: key.privateKeyPem }
}

/** Store the issued pair sealed and point the hostname at it; the pair before last is deleted. */
export async function storeIssuedPair(
  deps: Pick<Dns01Deps, 'db' | 'dataEncryption'>,
  row: Dns01Row,
  pair: { certPem: string; keyPem: string }
): Promise<{ id: string; notAfter: Date; notBefore: Date }> {
  const parsed = await parseCertificatePem(pair.certPem)
  const inserted = await deps.db
    .insert(instanceUploadedCertificate)
    .values({
      label: `DNS-01 ${row.name}`,
      certPem: pair.certPem,
      keyPem: await encryptSecret(deps.dataEncryption, pair.keyPem),
      dnsNames: parsed.dnsNames,
      notAfter: parsed.notAfter.toISOString(),
      kind: 'acme-dns-01',
    })
    .returning({ id: instanceUploadedCertificate.id })
  const id = inserted[0]!.id
  await deps.db
    .update(instanceHostname)
    .set({ uploadedCertId: id, notAfter: parsed.notAfter.toISOString(), acmeLastError: null })
    .where(eq(instanceHostname.id, row.id))
  const stale = row.state.previousCertId
  if (stale && stale !== row.uploadedCertId) {
    await deps.db
      .delete(instanceUploadedCertificate)
      .where(
        and(
          eq(instanceUploadedCertificate.id, stale),
          ne(instanceUploadedCertificate.kind, 'uploaded')
        )
      )
  }
  return { id, notAfter: parsed.notAfter, notBefore: parsed.notBefore }
}

async function issue(
  deps: Dns01Deps,
  row: Dns01Row,
  order: Dns01Order,
  acme: AcmeClient
): Promise<Dns01State> {
  const pair = await finalizeOrder(deps, acme, order, row.name)
  const stored = await storeIssuedPair(deps, row, pair)
  await removeRecord(deps, row, order)
  const issuedAt = deps.now()
  const plan = await planRenewal({
    certPem: pair.certPem,
    issuedAt,
    notAfter: stored.notAfter,
    directoryUrl: dns01Directory(deps.settings),
    fetch: deps.fetch,
    random: deps.random,
  })
  const state: Dns01State = {
    ...IDLE_STATE,
    stage: 'issued',
    attemptTimes: row.state.attemptTimes,
    renewAt: plan.renewAt.toISOString(),
    replaces: plan.replaces,
    issuedAt: issuedAt.toISOString(),
    previousCertId: row.uploadedCertId,
  }
  await saveDns01State(deps.db, row.id, state, { acmeLastAttemptAt: issuedAt.toISOString() })
  await pushToDaemon(deps, row.id)
  return state
}

/**
 * The new leaf goes out at once; a failed push is shown, and the next apply
 * that carries this pair (the edge trust tick resends it, as does Apply)
 * clears the error.
 */
export async function pushToDaemon(
  deps: Pick<Dns01Deps, 'db' | 'applyToDaemon'>,
  id: string
): Promise<void> {
  try {
    await deps.applyToDaemon()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await deps.db
      .update(instanceHostname)
      .set({ acmeLastError: daemonNotLoadedError(reason) })
      .where(eq(instanceHostname.id, id))
  }
}

async function validate(deps: Dns01Deps, row: Dns01Row, order: Dns01Order): Promise<Dns01State> {
  const acme = await client(deps)
  const authz = await acme.getAuthorization(order.authzUrl)
  if (authz.status === 'valid') return await issue(deps, row, order, acme)
  if (authz.status !== 'pending')
    return await recordFailure(deps, row, challengeFailure(authz), null)
  if (deps.now().getTime() - Date.parse(order.startedAt) < ORDER_TIMEOUT_MS) return row.state
  const detail = 'The certificate authority did not finish validating in time.'
  return await recordFailure(deps, row, { cause: 'acme-error', detail }, null, undefined, 'abandon')
}

/** Move an open order one step on. Idempotent: a step that has nothing to do yet returns the state as is. */
export async function advanceOrder(deps: Dns01Deps, row: Dns01Row): Promise<Dns01State> {
  const order = row.state.order
  if (!order) return row.state
  try {
    if (row.state.stage === 'waiting-dns') return await waitForDns(deps, row, order)
    if (row.state.stage === 'validating') return await validate(deps, row, order)
    return row.state
  } catch (err) {
    return await failWith(deps, row, err)
  }
}
