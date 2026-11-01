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
import type { DnsChallengeProvider } from '../../../../features/tls/dns-certificates/dns-provider.ts'
import { AcmeError, type AcmeAuthorization, type AcmeClient } from '../../../../lib/acme/client.ts'
import { buildCertificateRequest, generateCertificateKey } from '../../../../lib/acme/csr.ts'
import { forEachSequential } from '../../../../lib/sequential.ts'
import { encryptSecret } from '../../../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../../../lib/secrets/secrets.ts'
import { parseCertificatePem } from '../../../../lib/tls/index.ts'
import { type IngressAccountRecord, listIngressAccounts, zoneForName } from '../accounts.ts'
import { dnsName } from '../cloudflare/tunnel-config.ts'
import { dns01Directory, forgetInstanceAcmeAccount, instanceAcmeClient } from './account.ts'
import { alertOnFailure, type Notify } from './alerts.ts'
import { DNS01_MAX_ATTEMPTS, mapAcmeFailure, nextAttemptAt, startsInLastHour } from './backoff.ts'
import { type DnsLookup, preflightDns01, txtVisibleOnAll } from './preflight.ts'
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
    .where(and(eq(instanceHostname.id, id), eq(instanceHostname.source, 'dns-01')))
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

/** Back off (or stop, after too many tries) and tell the operator once per cause. */
export async function recordFailure(
  deps: Dns01Deps,
  row: Dns01Row,
  failure: Dns01Failure,
  stopUntil: Date | null
): Promise<Dns01State> {
  await removeRecord(deps, row, row.state.order)
  const now = deps.now()
  const attempts = row.state.attempts + 1
  const exhausted = attempts >= DNS01_MAX_ATTEMPTS
  const retry = stopUntil ?? nextAttemptAt(now, attempts, deps.random, row.state.attemptTimes)
  const failed = withStage(row.state, exhausted ? 'failed' : 'backoff', {
    order: null,
    attempts,
    nextAttemptAt: exhausted ? null : retry.toISOString(),
    stopUntil: stopUntil?.toISOString() ?? row.state.stopUntil,
    lastError: { ...failure, at: now.toISOString() },
  })
  const alerted = await alertOnFailure(failed, row.name, failure, failed.nextAttemptAt, deps.notify)
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
  return await recordFailure(
    deps,
    row,
    { cause: mapped.cause, detail: mapped.detail },
    mapped.stopUntil
  )
}

function client(deps: Dns01Deps): Promise<AcmeClient> {
  return instanceAcmeClient(deps.db, {
    dataEncryption: deps.dataEncryption,
    fetch: deps.fetch,
    settings: deps.settings,
  })
}

async function openOrder(
  deps: Dns01Deps,
  row: Dns01Row,
  provider: DnsChallengeProvider,
  zoneId: string,
  nameservers: string[]
): Promise<Dns01Order> {
  const acme = await client(deps)
  // A renewal names the certificate it replaces, so the authority exempts it from limits.
  const replaces = row.uploadedCertId ? row.state.replaces : null
  const order = await acme.newOrder([row.name], replaces ? { replaces } : {})
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

async function startWith(
  deps: Dns01Deps,
  row: Dns01Row,
  account: IngressAccountRecord
): Promise<Dns01State> {
  const provider = await deps.challengeProvider(account)
  const checked = await preflightDns01({
    provider,
    dns: deps.dns,
    zones: account.scopes?.zones ?? [],
    host: row.name,
  })
  if (!checked.ok || !checked.zone) {
    return await recordFailure(
      deps,
      row,
      checked.failure ?? { cause: 'provider-error', detail: 'Preflight failed.' },
      null
    )
  }
  const order = await openOrder(deps, row, provider, checked.zone.id, checked.nameservers)
  const state = withStage(row.state, 'waiting-dns', { order, nextAttemptAt: null })
  await saveDns01State(deps.db, row.id, state, { acmeLastAttemptAt: order.startedAt })
  return state
}

export type StartRefusal = { ok: false; error: string }

/** Start an order now. Refused while the authority's limit pauses the name. */
export async function startOrder(
  deps: Dns01Deps,
  row: Dns01Row
): Promise<Dns01State | StartRefusal> {
  const now = deps.now()
  const stop = Date.parse(row.state.stopUntil ?? '')
  if (!Number.isNaN(stop) && stop > now.getTime()) {
    return {
      ok: false,
      error: `Retry is paused until ${row.state.stopUntil} by the certificate authority's limit.`,
    }
  }
  const attemptTimes = [...startsInLastHour(row.state.attemptTimes, now), now.toISOString()]
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
    return await startWith(deps, started, account)
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
  const detail = `The challenge record is not visible on ${visible.missing.length} of ${order.nameservers.length} authoritative nameservers yet.`
  return await recordFailure(deps, row, { cause: 'txt-not-visible', detail }, null)
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
      kind: 'dns-01',
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

/** The new leaf goes out at once; a failed push is shown, and the next apply retries it. */
async function pushToDaemon(deps: Dns01Deps, id: string): Promise<void> {
  try {
    await deps.applyToDaemon()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await deps.db
      .update(instanceHostname)
      .set({
        acmeLastError: `The certificate was issued but the daemon has not loaded it yet: ${reason}`,
      })
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
  return await recordFailure(deps, row, { cause: 'acme-error', detail }, null)
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
