/**
 * Cloudflare origin certificate, per name. A name saved as `cloudflare_origin`
 * with no pin gets its certificate here, the counterpart of
 * `ensureNameHttpOrders` for the origin certificate: an API token of the
 * organization that has certificate rights for the name's zone issues it (or an
 * existing covering certificate is reused), and `hostname.tls_id` pins it.
 * Nothing else issues a certificate for a name that only picked the choice.
 *
 * Unlike the Let's Encrypt order this calls the provider, so it runs after the
 * save has committed, never inside it. The whole step runs under an advisory
 * lock per organization and re-reads the waiting names under it: a second
 * caller (a double click, the scheduled retry, a tunnel attach) finds the names
 * pinned and issues nothing. The lock is held across the provider call on
 * purpose; origin certificates are few and the per-organization cap is 50.
 *
 * Names of one zone share one certificate. Only the organization's own
 * carriers and tokens are looked at; the token is picked with `pickBadges` on
 * the certificate rights recorded for it (the rule the manual issue route
 * uses). A name that cannot get its certificate records why on the site
 * (`features/hostings/name-origin-issues.ts`), with a back-off the scheduled
 * retry honours; a save or a tunnel attach tries at once.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { hostname, hosting } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { readHostingComposeOwner } from '../../features/hostings/hosting-compose-owner.ts'
import {
  type NameOriginIssue,
  type NameOriginIssueCode,
  type NameOriginIssues,
  nameOriginIssueWaiting,
  readNameOriginIssues,
  saveNameOriginIssues,
} from '../../features/hostings/name-origin-issues.ts'
import { getCommandQueue } from '../../features/commands/queue.ts'
import { TunnelProviderError } from '../../features/tunnels/errors.ts'
import {
  ensureOriginCertificate,
  OriginCertificateRefusal,
} from '../../features/tunnels/origin-certificate.ts'
import { nextOriginRetry } from '../../features/tunnels/origin-certificate-retry.ts'
import {
  type BadgeRow,
  type CarrierRow,
  listCarriers,
  pickBadges,
  toApiBadge,
} from '../../features/tunnels/records.ts'
import {
  createTunnelAdapterRegistry,
  type TunnelAdapterRegistry,
} from '../../features/tunnels/registry.ts'
import type { TunnelProvider } from '../../features/tunnels/vocabulary.ts'
import { compareText } from '../../features/tunnels/order.ts'
import { logWarn } from '../../lib/logger.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { type HostingApplyDeps, queueHostingCertificateApply } from './letsencrypt-apply.ts'

/** How long a name with no usable API token waits before the scheduled retry looks again. */
export const NO_BADGE_RETRY_MS = 15 * 60_000

export type NameOriginDeps = {
  /** The data-encryption secrets that open the API tokens; without them nothing is issued. */
  secrets: DerivedSecretsConfig | null
  registry?: TunnelAdapterRegistry
  now?: Date
  /** Who asked, for the audit entry; null for the scheduled retry. */
  actor?: { userId: string | null; email: string | null }
  /** Skip names still waiting out an earlier failure (the scheduled retry). */
  respectBackoff?: boolean
}

export type NameOriginOutcome = {
  /** Names that now hold a certificate. */
  pinned: string[]
  /** Names that could not get one; the reason is recorded on the site. */
  failed: string[]
}

type Zone = { id: string; name: string }
type Placement = { carrier: CarrierRow; badge: BadgeRow; zone: Zone }
type Group = Placement & { names: string[] }
type Failure = { code: NameOriginIssueCode; message: string; error: unknown }

const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'unsupported_provider',
  'zone_not_covered',
  'secrets_unavailable',
  'badge_cannot_certify',
  'origin_certificate_limit',
  'origin_certificate_names',
])

async function waitingNames(db: Db, hostingId: string, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ name: hostname.hostname })
    .from(hostname)
    .where(
      and(
        eq(hostname.hostingId, hostingId),
        eq(hostname.routingOrganizationId, organizationId),
        eq(hostname.certificate, 'cloudflare_origin'),
        isNull(hostname.tlsId)
      )
    )
  return rows.map((row) => row.name).toSorted(compareText)
}

/** Zones an active token of the carrier has certificate rights for. */
function certificateZones(badges: readonly BadgeRow[]): Zone[] {
  const zones = new Map<string, Zone>()
  for (const row of badges) {
    if (row.status !== 'active') continue
    for (const zone of toApiBadge(row).capabilities.certificates) zones.set(zone.id, zone)
  }
  return [...zones.values()]
}

function insideZone(name: string, zone: Zone): boolean {
  const zoneName = zone.name.toLowerCase()
  return name === zoneName || name.endsWith(`.${zoneName}`)
}

/** The token that can issue for the name: the carrier and zone with the longest zone name that holds it. */
function placeName(
  name: string,
  carriers: readonly { carrier: CarrierRow; badges: BadgeRow[] }[]
): Placement | null {
  let best: Placement | null = null
  for (const { carrier, badges } of carriers) {
    for (const zone of certificateZones(badges)) {
      if (!insideZone(name, zone)) continue
      if (best !== null && best.zone.name.length >= zone.name.length) continue
      const badge = pickBadges(badges, { capability: 'certificates', zone }).badges[0]
      if (badge) best = { carrier, badge, zone }
    }
  }
  return best
}

function planNames(
  names: readonly string[],
  carriers: readonly { carrier: CarrierRow; badges: BadgeRow[] }[]
): { groups: Group[]; unplaced: string[] } {
  const groups = new Map<string, Group>()
  const unplaced: string[] = []
  for (const name of names) {
    const placed = placeName(name, carriers)
    if (placed === null) {
      unplaced.push(name)
      continue
    }
    const key = `${placed.carrier.id}:${placed.zone.id}`
    const group = groups.get(key) ?? { ...placed, names: [] }
    group.names.push(name)
    groups.set(key, group)
  }
  return { groups: [...groups.values()], unplaced }
}

/** Turn a failed issue into a reason; an error that is not the provider's or a refusal is not ours to hide. */
function classify(err: unknown): Failure | null {
  if (err instanceof OriginCertificateRefusal) {
    const code = REFUSAL_CODES.has(err.error)
      ? (err.error as NameOriginIssueCode)
      : 'provider_error'
    return { code, message: err.message, error: err }
  }
  if (err instanceof TunnelProviderError) {
    return { code: 'provider_error', message: err.message, error: err }
  }
  return null
}

function noBadgeIssue(name: string, previous: NameOriginIssue | undefined, now: Date) {
  const issue: NameOriginIssue = {
    code: 'no_badge',
    message: `No connected API token has certificate rights for the zone of ${name}. Add or recheck a token that can manage certificates for it.`,
    failedAt: now.toISOString(),
    attempts: (previous?.attempts ?? 0) + 1,
    nextTryAt: new Date(now.getTime() + NO_BADGE_RETRY_MS).toISOString(),
  }
  return issue
}

function failureIssue(failure: Failure, previous: NameOriginIssue | undefined, now: Date) {
  const retry = nextOriginRetry(
    { attempts: previous?.attempts ?? 0, nextTryAt: null },
    failure.error,
    now
  )
  const issue: NameOriginIssue = {
    code: failure.code,
    message: failure.message,
    failedAt: now.toISOString(),
    attempts: retry.attempts,
    nextTryAt: retry.nextTryAt,
  }
  return issue
}

type IssuedAudit = { tlsId: string; carrierId: string; zone: string }

/** Issue (or reuse) the certificate of one zone's names. Returns the pinned row's id. */
async function issueGroup(
  tx: Db,
  ctx: { organizationId: string; deps: NameOriginDeps; registry: TunnelAdapterRegistry },
  group: Group
): Promise<{ tlsId: string; reused: boolean }> {
  if (ctx.deps.secrets === null) {
    throw new OriginCertificateRefusal('secrets_unavailable', 'The stored API token cannot be read')
  }
  const ensured = await ensureOriginCertificate({
    db: tx,
    secrets: ctx.deps.secrets,
    adapter: ctx.registry(group.carrier.provider as TunnelProvider),
    organizationId: ctx.organizationId,
    carrier: group.carrier,
    badge: group.badge,
    zoneName: group.zone.name,
    names: group.names,
    scope: 'names',
    ...(ctx.deps.now ? { now: ctx.deps.now } : {}),
  })
  return { tlsId: ensured.row.id, reused: ensured.reused }
}

type RunState = {
  pins: Map<string, string>
  failures: Map<string, Failure | 'no_badge'>
  issued: IssuedAudit[]
}

async function runGroups(
  tx: Db,
  ctx: { organizationId: string; deps: NameOriginDeps; registry: TunnelAdapterRegistry },
  plan: { groups: Group[]; unplaced: string[] }
): Promise<RunState> {
  const state: RunState = { pins: new Map(), failures: new Map(), issued: [] }
  for (const name of plan.unplaced) state.failures.set(name, 'no_badge')
  await forEachSequential(plan.groups, async (group) => {
    try {
      const done = await issueGroup(tx, ctx, group)
      for (const name of group.names) state.pins.set(name, done.tlsId)
      if (!done.reused) {
        state.issued.push({
          tlsId: done.tlsId,
          carrierId: group.carrier.id,
          zone: group.zone.name,
        })
      }
    } catch (err) {
      const failure = classify(err)
      if (failure === null) throw err
      for (const name of group.names) state.failures.set(name, failure)
    }
  })
  return state
}

/** The reasons to store: what was recorded for names still waiting, with this run's results applied. */
function nextIssues(
  previous: NameOriginIssues,
  waiting: readonly string[],
  state: RunState,
  now: Date
): NameOriginIssues {
  const out: NameOriginIssues = {}
  for (const name of waiting) {
    const old = previous[name]
    if (state.pins.has(name)) continue
    const failure = state.failures.get(name)
    if (failure === undefined) {
      if (old) out[name] = old
    } else {
      out[name] =
        failure === 'no_badge' ? noBadgeIssue(name, old, now) : failureIssue(failure, old, now)
    }
  }
  return out
}

async function pinNames(
  tx: Db,
  hostingId: string,
  organizationId: string,
  pins: ReadonlyMap<string, string>
): Promise<string[]> {
  const pinned: string[] = []
  await forEachSequential([...pins], async ([name, tlsId]) => {
    // The same predicate the waiting names were read with, so a name changed meanwhile is left alone.
    const rows = await tx
      .update(hostname)
      .set({ tlsId })
      .where(
        and(
          eq(hostname.hostingId, hostingId),
          eq(hostname.routingOrganizationId, organizationId),
          eq(hostname.hostname, name),
          eq(hostname.certificate, 'cloudflare_origin'),
          isNull(hostname.tlsId)
        )
      )
      .returning({ name: hostname.hostname })
    if (rows.length > 0) pinned.push(name)
  })
  return pinned
}

async function lockOrganizationOriginIssue(tx: Db, organizationId: string): Promise<void> {
  const lockKey = 'origin-certificate-issue:' + organizationId
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)
}

async function runLocked(
  tx: Db,
  hostingId: string,
  organizationId: string,
  deps: NameOriginDeps
): Promise<NameOriginOutcome & { issued: IssuedAudit[] }> {
  const now = deps.now ?? new Date()
  const waiting = await waitingNames(tx, hostingId, organizationId)
  const [site] = await tx
    .select({ metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  const previous = readNameOriginIssues(site?.metadata)
  const due = waiting.filter(
    (name) => !(deps.respectBackoff && nameOriginIssueWaiting(previous[name], now))
  )
  const registry = deps.registry ?? createTunnelAdapterRegistry()
  const plan = planNames(due, await listCarriers(tx, organizationId))
  const state = await runGroups(tx, { organizationId, deps, registry }, plan)
  const issues = nextIssues(previous, waiting, state, now)
  // The site row before the name rows, the order a save writes them in.
  if (JSON.stringify(issues) !== JSON.stringify(previous)) {
    await saveNameOriginIssues(tx, hostingId, issues)
  }
  const pinned = await pinNames(tx, hostingId, organizationId, state.pins)
  return {
    pinned,
    failed: [...state.failures.keys()].toSorted(compareText),
    issued: state.issued,
  }
}

/** Remove reasons for names that no longer ask for the origin certificate. */
async function dropStaleIssues(db: Db, hostingId: string): Promise<void> {
  const [site] = await db
    .select({ metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  if (Object.keys(readNameOriginIssues(site?.metadata)).length > 0) {
    await saveNameOriginIssues(db, hostingId, {})
  }
}

/**
 * Give every name of the hosting that is set to the Cloudflare origin
 * certificate and holds no pin a certificate, and pin it. Safe to call twice at
 * once. Run after the save that chose the certificate has committed. A site
 * that a compose file owns keeps the certificate its compose file names.
 */
export async function ensureNameOriginCertificates(
  db: Db,
  hostingId: string,
  organizationId: string,
  deps: NameOriginDeps
): Promise<NameOriginOutcome> {
  const none: NameOriginOutcome = { pinned: [], failed: [] }
  if ((await waitingNames(db, hostingId, organizationId)).length === 0) {
    await dropStaleIssues(db, hostingId)
    return none
  }
  const [site] = await db
    .select({ metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  if (!site || readHostingComposeOwner(site.metadata) !== null) return none
  const done = await db.transaction(async (tx) => {
    await lockOrganizationOriginIssue(tx, organizationId)
    return runLocked(tx, hostingId, organizationId, deps)
  })
  await forEachSequential(done.issued, async (issued) => {
    await recordAudit(db, {
      organizationId,
      actorUserId: deps.actor?.userId ?? null,
      actorEmail: deps.actor?.email ?? null,
      action: 'origin_certificate.issue',
      targetType: 'organization',
      targetId: issued.tlsId,
      context: {
        carrierId: issued.carrierId,
        zone: issued.zone,
        scope: 'names',
        hostingId,
      },
    })
  })
  return { pinned: done.pinned, failed: done.failed }
}

/**
 * The call the routes make: issue what the hosting's names wait for and, when
 * something was pinned, queue the hostings-only apply that sends the pair to
 * the servers (when that is not safe right now the pair goes with the next
 * deploy). Never throws: a failure here must not undo the save or the attach
 * that triggered it, and the reason is on the site.
 */
export async function issueNameOriginCertificates(
  c: Context<AppEnv>,
  db: Db,
  params: {
    hostingId: string
    organizationId: string
    actor: { userId: string; email: string | null }
    registry?: TunnelAdapterRegistry
    applyDeps?: HostingApplyDeps
  }
): Promise<NameOriginOutcome> {
  const none: NameOriginOutcome = { pinned: [], failed: [] }
  try {
    const [site] = await db
      .select({ updatedAt: hosting.updatedAt })
      .from(hosting)
      .where(eq(hosting.id, params.hostingId))
      .limit(1)
    if (!site) return none
    const done = await ensureNameOriginCertificates(db, params.hostingId, params.organizationId, {
      secrets: c.get('dataEncryptionSecrets') ?? null,
      ...(params.registry ? { registry: params.registry } : {}),
      actor: params.actor,
    })
    if (done.pinned.length > 0) {
      await queueHostingCertificateApply(
        c,
        db,
        {
          hostingId: params.hostingId,
          organizationId: params.organizationId,
          actor: { actorType: 'user', actorId: params.actor.userId },
          editedAt: site.updatedAt,
        },
        params.applyDeps ?? { commandQueue: getCommandQueue(c) }
      )
    }
    return done
  } catch (err) {
    logWarn(
      'hostings',
      `origin certificate for hosting ${params.hostingId} failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return none
  }
}

/** Hostings the scheduled retry looks at per pass; each one may call the provider. */
export const NAME_ORIGIN_SWEEP_BATCH = 10

/** Waiting names read per pass, before the ones still backing off are set aside. */
const NAME_ORIGIN_SWEEP_SCAN = 500

export type NameOriginSweepResult = {
  tried: number
  failed: number
  /** Sites that gained a certificate, to send to their servers. */
  pinned: { hostingId: string; organizationId: string; editedAt: string }[]
}

/**
 * The scheduled retry: hostings with a name set to the origin certificate and
 * no pin, whose recorded back-off has passed, oldest first. Each runs the same
 * step a save runs. It adds no timer; the Let's Encrypt retry tick calls it.
 * Without the data-encryption secrets it does nothing.
 */
export async function sweepNameOriginCertificates(
  db: Db,
  deps: { secrets: DerivedSecretsConfig | null; registry?: TunnelAdapterRegistry; now?: Date }
): Promise<NameOriginSweepResult> {
  const out: NameOriginSweepResult = { tried: 0, failed: 0, pinned: [] }
  if (deps.secrets === null) return out
  const now = deps.now ?? new Date()
  const rows = await db
    .select({
      hostingId: hostname.hostingId,
      organizationId: hostname.routingOrganizationId,
      name: hostname.hostname,
      metadata: hosting.metadata,
      updatedAt: hosting.updatedAt,
    })
    .from(hostname)
    .innerJoin(hosting, eq(hosting.id, hostname.hostingId))
    .where(and(eq(hostname.certificate, 'cloudflare_origin'), isNull(hostname.tlsId)))
    .orderBy(asc(hostname.updatedAt), asc(hostname.id))
    .limit(NAME_ORIGIN_SWEEP_SCAN)
  const due = new Map<string, { organizationId: string; updatedAt: string }>()
  for (const row of rows) {
    const issue = readNameOriginIssues(row.metadata)[row.name]
    if (nameOriginIssueWaiting(issue, now) || due.has(row.hostingId)) continue
    due.set(row.hostingId, { organizationId: row.organizationId, updatedAt: row.updatedAt })
  }
  await forEachSequential([...due].slice(0, NAME_ORIGIN_SWEEP_BATCH), async ([id, site]) => {
    out.tried += 1
    try {
      const done = await ensureNameOriginCertificates(db, id, site.organizationId, {
        secrets: deps.secrets,
        respectBackoff: true,
        now,
        ...(deps.registry ? { registry: deps.registry } : {}),
      })
      out.failed += done.failed.length
      if (done.pinned.length > 0) {
        out.pinned.push({
          hostingId: id,
          organizationId: site.organizationId,
          editedAt: site.updatedAt,
        })
      }
    } catch (err) {
      out.failed += 1
      logWarn(
        'tls',
        `origin certificate for hosting ${id} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })
  return out
}
