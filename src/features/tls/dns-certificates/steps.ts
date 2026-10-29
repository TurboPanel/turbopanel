/**
 * The steps of one DNS-validated order. Each step does a small, bounded amount
 * of work (a few requests) and returns the new state, so a request or a sweep
 * tick never waits for the whole order.
 *
 * Records are only ever removed by the id the provider gave when the panel
 * made them, never by name: a zone may hold someone else's `_acme-challenge`
 * record, and only ours may go. Each id is written to the row the moment the
 * record exists, so an interrupted request still leaves a list to clean up.
 */
import { and, eq, sql } from 'drizzle-orm'
import { tls } from '../../../db/schema.ts'
import { AcmeClient, AcmeError, type AcmeAuthorization } from '../../../lib/acme/client.ts'
import { buildCertificateRequest, loadCertificateKey } from '../../../lib/acme/csr.ts'
import { acmeDirectoryUrl } from '../../../lib/acme/directories.ts'
import { importAccountKey } from '../../../lib/acme/jws.ts'
import { decryptSecret } from '../../../lib/secrets/data-encryption.ts'
import { TunnelProviderError } from '../../tunnels/errors.ts'
import { findCarrier } from '../../tunnels/records.ts'
import type { TunnelProvider } from '../../tunnels/vocabulary.ts'
import { orgAccount } from './account.ts'
import { openDnsToken } from './token.ts'
import { clock, type DnsCertContext, PRESENT_GRACE_MS } from './context.ts'
import {
  ChallengeTargetError,
  challengeRecordName,
  type DnsChallengeProvider,
} from './dns-provider.ts'
import type {
  ChallengeState,
  DnsCertState,
  OrderState,
  PublishedRecord,
  ZoneRef,
} from './order-state.ts'

/** What a step needs to know about the row it works on. */
export type OrderRow = {
  id: string
  organizationId: string
  /** The names on the certificate. */
  names: string[]
  /** The sealed key of a first certificate (a renewal carries its own in the order). */
  sealedKey: string | null
}

export type StepResult =
  | { kind: 'wait'; state: DnsCertState }
  | { kind: 'continue'; state: DnsCertState }
  | { kind: 'issued'; state: DnsCertState; chainPem: string }

/** A CNAME chain longer than this is treated as a loop. */
const MAX_CNAME_HOPS = 5

async function openClient(ctx: DnsCertContext, state: DnsCertState, order: OrderState) {
  const key = await importAccountKey(await decryptSecret(ctx.secrets, order.accountKey))
  return new AcmeClient({
    directoryUrl: acmeDirectoryUrl(state.staging),
    key,
    accountUrl: order.accountUrl,
    fetch: ctx.acmeFetch,
  })
}

/** The DNS host for one zone: the carrier's provider and a token that reaches the zone. */
async function dnsFor(
  ctx: DnsCertContext,
  row: OrderRow,
  state: DnsCertState,
  zoneId: string
): Promise<DnsChallengeProvider> {
  const carrier = await findCarrier(ctx.db, row.organizationId, state.carrierId)
  const token = carrier ? await openDnsToken(ctx, carrier.id, { zone: { id: zoneId } }) : null
  if (!carrier || !token) {
    throw new TunnelProviderError(
      'forbidden',
      'No token on this account can edit DNS records for the zone',
      null
    )
  }
  return ctx.dns(carrier.provider as TunnelProvider, token)
}

function zoneFor(zones: readonly ZoneRef[], name: string): ZoneRef | undefined {
  return zones
    .filter((z) => name === z.name || name.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0]
}

/** The zone of `name` among the zones the certificate already uses, or any zone the account can edit. */
async function findZoneOf(
  ctx: DnsCertContext,
  row: OrderRow,
  state: DnsCertState,
  name: string
): Promise<ZoneRef | null> {
  const known = zoneFor(state.zones, name)
  if (known) return known
  const carrier = await findCarrier(ctx.db, row.organizationId, state.carrierId)
  const token = carrier ? await openDnsToken(ctx, carrier.id, 'any') : null
  if (!carrier || !token) return null
  try {
    return await ctx.adapters(carrier.provider as TunnelProvider).findZone(token, {
      accountId: carrier.externalAccountId,
      hostname: name,
    })
  } catch (err) {
    if (err instanceof TunnelProviderError && err.code === 'zone_not_found') return null
    throw err
  }
}

/**
 * Where the record for `name` has to be written. A TXT record cannot sit
 * beside a CNAME, so a CNAME at the challenge name is followed to its target;
 * when the target's zone cannot be edited the order stops, saying so.
 */
async function writeTarget(
  ctx: DnsCertContext,
  row: OrderRow,
  state: DnsCertState,
  at: { name: string; zoneId: string },
  depth = 0
): Promise<{ name: string; zoneId: string }> {
  const dns = await dnsFor(ctx, row, state, at.zoneId)
  const target = await dns.lookupCname({ zoneId: at.zoneId, name: at.name })
  if (target === null) return at
  if (depth >= MAX_CNAME_HOPS) {
    throw new ChallengeTargetError(
      at.name,
      target,
      'The aliases point at each other or are too long.'
    )
  }
  const zone = await findZoneOf(ctx, row, state, target)
  if (!zone) {
    throw new ChallengeTargetError(at.name, target, 'This account has no zone for that name.')
  }
  return await writeTarget(ctx, row, state, { name: target, zoneId: zone.id }, depth + 1)
}

type Pending = Omit<ChallengeState, 'recordId'>

async function pendingChallenge(
  client: AcmeClient,
  authz: AcmeAuthorization
): Promise<Omit<Pending, 'zoneId'>> {
  const challenge = authz.challenges.find((c) => c.type === 'dns-01')
  if (!challenge) throw new AcmeError('malformed', 'The authority offered no DNS challenge')
  return {
    authzUrl: authz.url,
    challengeUrl: challenge.url,
    token: challenge.token,
    name: challengeRecordName(authz.identifier.value),
    value: await client.dnsValue(challenge.token),
  }
}

const leftovers = new WeakMap<object, PublishedRecord[]>()

/** Tie the records that could not be removed to the error, so the failure handler keeps them for the sweep. */
function withLeftovers(reason: unknown, records: PublishedRecord[]): object {
  const err = typeof reason === 'object' && reason !== null ? reason : new Error(String(reason))
  leftovers.set(err, records)
  return err
}

/** The records a failed publish could not take away again (empty for any other error). */
export function leftoverRecords(err: unknown): readonly PublishedRecord[] {
  return typeof err === 'object' && err !== null ? (leftovers.get(err) ?? []) : []
}

/** Remember a record the moment it exists, apart from the rest of the state. */
async function rememberRecord(ctx: DnsCertContext, rowId: string, rec: PublishedRecord) {
  await ctx.db
    .update(tls)
    .set({
      metadata: sql`jsonb_set(${tls.metadata}, '{dnsCert,records}', coalesce(${tls.metadata} #> '{dnsCert,records}', '[]'::jsonb) || ${JSON.stringify([rec])}::jsonb)`,
    })
    .where(and(eq(tls.id, rowId), eq(tls.source, 'upload')))
}

/**
 * Publish every record. If one cannot be made, the ones already made are
 * removed again and the error is thrown. The returned records are all ours.
 */
async function publishAll(
  ctx: DnsCertContext,
  row: OrderRow,
  state: DnsCertState,
  pending: readonly Omit<Pending, 'zoneId'>[]
): Promise<{ challenges: ChallengeState[]; records: PublishedRecord[] }> {
  const made: PublishedRecord[] = []
  const settled = await Promise.allSettled(
    pending.map(async (p): Promise<ChallengeState> => {
      const zone = zoneFor(state.zones, p.name.replace(/^_acme-challenge\./, ''))
      if (!zone) throw new TypeError(`No zone is known for ${p.name}`)
      const where = await writeTarget(ctx, row, state, { name: p.name, zoneId: zone.id })
      const dns = await dnsFor(ctx, row, state, where.zoneId)
      const ref = await dns.present({ zoneId: where.zoneId, name: where.name, value: p.value })
      const rec = {
        zoneId: where.zoneId,
        recordId: ref.recordId,
        name: where.name,
        createdAt: clock(ctx).toISOString(),
      }
      made.push(rec)
      await rememberRecord(ctx, row.id, rec)
      return { ...p, name: where.name, zoneId: where.zoneId, recordId: ref.recordId }
    })
  )
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  const challenges = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
  if (failed) {
    const cleaned = await cleanRecords(ctx, row, { ...state, records: [...state.records, ...made] })
    throw withLeftovers(failed.reason, cleaned.records)
  }
  return { challenges, records: made }
}

/**
 * Remove every record this panel made for the row, by id. A record that cannot
 * be removed stays on the list for the next try; nothing else is ever touched.
 */
export async function cleanRecords(
  ctx: DnsCertContext,
  row: OrderRow,
  state: DnsCertState
): Promise<DnsCertState> {
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

/** The organization's account and a new order on it; an account the authority has switched off is replaced once. */
async function startOrder(ctx: DnsCertContext, row: OrderRow, state: DnsCertState) {
  const attempt = async (replace: boolean) => {
    const account = await orgAccount(ctx, row.organizationId, state.staging, { replace })
    return { account, order: await account.client.newOrder(row.names) }
  }
  try {
    return await attempt(false)
  } catch (err) {
    if (!(err instanceof AcmeError) || err.code !== 'account_gone') throw err
    return await attempt(true)
  }
}

/** Open an order and publish the challenge records. */
export async function openOrder(
  ctx: DnsCertContext,
  row: OrderRow,
  state: DnsCertState,
  renewal: { pendingKey: string } | null
): Promise<StepResult> {
  const { account, order } = await startOrder(ctx, row, state)
  const authorizations = await Promise.all(
    order.authorizations.map((u) => account.client.getAuthorization(u))
  )
  const pending = await Promise.all(authorizations.map((a) => pendingChallenge(account.client, a)))
  const published = await publishAll(ctx, row, state, pending)
  const at = clock(ctx).toISOString()
  const next: OrderState = {
    accountKey: account.sealedKey,
    accountUrl: account.accountUrl,
    orderUrl: order.url,
    finalizeUrl: order.finalize,
    challenges: published.challenges,
    startedAt: at,
    presentedAt: at,
    answeredAt: null,
    finalizedAt: null,
    pendingKey: renewal?.pendingKey ?? null,
    renewal: renewal !== null,
  }
  const records = [...state.records, ...published.records]
  return { kind: 'wait', state: { ...state, records, order: next } }
}

/** After a short pause, tell the authority the records are in place. */
export async function answerChallenges(
  ctx: DnsCertContext,
  state: DnsCertState,
  order: OrderState
): Promise<StepResult> {
  const waited = clock(ctx).getTime() - Date.parse(order.presentedAt ?? order.startedAt)
  if (waited < (ctx.presentGraceMs ?? PRESENT_GRACE_MS)) return { kind: 'wait', state }
  const client = await openClient(ctx, state, order)
  await Promise.all(order.challenges.map((c) => client.answerChallenge(c.challengeUrl)))
  const answeredAt = clock(ctx).toISOString()
  return { kind: 'continue', state: { ...state, order: { ...order, answeredAt } } }
}

function invalidReason(authorizations: readonly AcmeAuthorization[]): AcmeError | null {
  for (const authz of authorizations) {
    if (authz.status === 'valid' || authz.status === 'pending') continue
    const detail = authz.challenges.find((c) => c.error)?.error?.detail ?? `${authz.status}`
    return new AcmeError('dns', detail)
  }
  return null
}

async function certificateKey(ctx: DnsCertContext, row: OrderRow, order: OrderState) {
  const sealed = order.pendingKey ?? row.sealedKey
  if (!sealed) throw new TypeError('The certificate has no key to sign the request with')
  return await loadCertificateKey(await decryptSecret(ctx.secrets, sealed))
}

async function sendRequest(
  ctx: DnsCertContext,
  row: OrderRow,
  client: AcmeClient,
  order: OrderState
): Promise<{ status: string; certificate?: string }> {
  const key = await certificateKey(ctx, row, order)
  const csr = await buildCertificateRequest({
    privateKey: key.privateKey,
    spki: key.spki,
    names: row.names,
  })
  return await client.finalize(order.finalizeUrl, csr)
}

/** Check the authorizations; when all are valid, send the request for the certificate. */
export async function checkValidation(
  ctx: DnsCertContext,
  row: OrderRow,
  state: DnsCertState,
  order: OrderState
): Promise<StepResult> {
  const client = await openClient(ctx, state, order)
  const urls = [...new Set(order.challenges.map((c) => c.authzUrl))]
  const authorizations = await Promise.all(urls.map((u) => client.getAuthorization(u)))
  const invalid = invalidReason(authorizations)
  if (invalid) throw invalid
  if (authorizations.some((a) => a.status !== 'valid')) return { kind: 'wait', state }
  const current = await client.getOrder(order.orderUrl)
  if (current.status === 'invalid') {
    throw new AcmeError('server', current.error?.detail ?? 'The order was not completed')
  }
  if (current.status !== 'ready') return { kind: 'wait', state }
  const sent = await sendRequest(ctx, row, client, order)
  const finalizedAt = clock(ctx).toISOString()
  return {
    kind: sent.status === 'valid' ? 'continue' : 'wait',
    state: { ...state, order: { ...order, finalizedAt } },
  }
}

/** Wait for the certificate, then download it. */
export async function collectCertificate(
  ctx: DnsCertContext,
  state: DnsCertState,
  order: OrderState
): Promise<StepResult> {
  const client = await openClient(ctx, state, order)
  const current = await client.getOrder(order.orderUrl)
  if (current.status === 'invalid') {
    throw new AcmeError('server', current.error?.detail ?? 'The order was not completed')
  }
  if (current.status !== 'valid' || !current.certificate) return { kind: 'wait', state }
  const chainPem = await client.downloadCertificate(current.certificate)
  return { kind: 'issued', state, chainPem }
}
