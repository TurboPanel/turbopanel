/**
 * Cloudflare origin certificate, per name. A name saved as `cloudflare_origin`
 * with no pin gets its certificate here, the counterpart of
 * `ensureNameHttpOrders` for the origin certificate: an API token of the
 * organization that has certificate rights for the name's zone issues it (or an
 * existing covering certificate is reused), and `hostname.tls_id` pins it.
 * Nothing else issues a certificate for a name that only picked the choice.
 *
 * Unlike the Let's Encrypt order this calls the provider, so it runs after the
 * save has committed, never inside it, and the provider is never called while
 * a lock or a transaction is held. The certificate is issued first (the issue
 * step takes the per-organization lock only to store it, and reuses a
 * certificate another caller stored meanwhile, revoking the extra one), then
 * the lock is taken again to record the outcome and pin the names that still
 * wait: a second caller (a double click, the scheduled retry, a tunnel attach)
 * finds the names pinned and pins nothing.
 *
 * Names of one zone share one certificate. Only the organization's own
 * carriers and tokens are looked at; the token is picked with `pickBadges` on
 * the certificate rights recorded for it (the rule the manual issue route
 * uses). A name that cannot get its certificate records why on the site
 * (`features/hostings/name-origin-issues.ts`), with a back-off the scheduled
 * retry honours; a save or a tunnel attach tries at once.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDaemonCellRegistry } from '../../db/connection.ts'
import { hostname, hosting } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { readHostingComposeOwner } from '../../features/hostings/hosting-compose-owner.ts'
import {
  NAME_ORIGIN_ISSUES_KEY,
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
  organizationOriginLock,
  OriginCertificateRefusal,
} from '../../features/tunnels/origin-certificate.ts'
import { nextOriginRetry } from '../../features/tunnels/origin-certificate-retry.ts'
import {
  type BadgeRow,
  type CarrierRow,
  capabilityProbeStale,
  declaredZonesOf,
  listCarriers,
  openBadgeToken,
  pickBadges,
  recordBadgeCheck,
  toApiBadge,
} from '../../features/tunnels/records.ts'
import {
  createTunnelAdapterRegistry,
  type TunnelAdapterRegistry,
} from '../../features/tunnels/registry.ts'
import { NO_CAPABILITIES, type TunnelProvider } from '../../features/tunnels/vocabulary.ts'
import { compareText } from '../../features/tunnels/order.ts'
import { logWarn } from '../../lib/logger.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  type HostingApplyDeps,
  type HostingPinState,
  leftServerFactsAlone,
  loadHostingPinState,
  queueHostingCertificateApply,
} from './letsencrypt-apply.ts'

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

type RunContext = { organizationId: string; deps: NameOriginDeps; registry: TunnelAdapterRegistry }

/** Issue (or reuse) the certificate of one zone's names. Returns the row's id. */
async function issueGroup(
  db: Db,
  ctx: RunContext,
  group: Group
): Promise<{ tlsId: string; reused: boolean }> {
  if (ctx.deps.secrets === null) {
    throw new OriginCertificateRefusal('secrets_unavailable', 'The stored API token cannot be read')
  }
  const ensured = await ensureOriginCertificate({
    db,
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
  db: Db,
  ctx: RunContext,
  plan: { groups: Group[]; unplaced: string[] }
): Promise<RunState> {
  const state: RunState = { pins: new Map(), failures: new Map(), issued: [] }
  for (const name of plan.unplaced) state.failures.set(name, 'no_badge')
  await forEachSequential(plan.groups, async (group) => {
    try {
      const done = await issueGroup(db, ctx, group)
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

type Carriers = { carrier: CarrierRow; badges: BadgeRow[] }[]

/**
 * A token added before certificates were checked has no certificate rights
 * recorded. Check each active one of that kind once and store what it reaches,
 * the way the manual issue route does. A provider that cannot be reached leaves
 * the token as it was. Returns whether anything was checked.
 */
async function recheckStaleBadges(db: Db, ctx: RunContext, carriers: Carriers): Promise<boolean> {
  const secrets = ctx.deps.secrets
  if (secrets === null) return false
  const stale = carriers.flatMap(({ carrier, badges }) =>
    badges
      .filter((b) => b.status === 'active' && capabilityProbeStale(b))
      .map((b) => ({ carrier, b }))
  )
  let checked = false
  await forEachSequential(stale, async ({ carrier, b }) => {
    const token = await openBadgeToken(db, secrets, b)
    if (token === null) return
    try {
      const report = await ctx.registry(carrier.provider as TunnelProvider).checkCredential(token, {
        accountId: carrier.externalAccountId,
        declaredZones: declaredZonesOf(b),
      })
      await recordBadgeCheck(db, b, {
        capabilities: report.capabilities ?? NO_CAPABILITIES,
        status: 'active',
        token: report.token,
      })
      checked = true
    } catch (err) {
      if (!(err instanceof TunnelProviderError)) throw err
    }
  })
  return checked
}

/** Where each due name goes; names no token can place get one look at their older tokens first. */
async function planDue(db: Db, ctx: RunContext, due: readonly string[]) {
  let carriers = await listCarriers(db, ctx.organizationId)
  let plan = planNames(due, carriers)
  if (plan.unplaced.length > 0 && (await recheckStaleBadges(db, ctx, carriers))) {
    carriers = await listCarriers(db, ctx.organizationId)
    plan = planNames(due, carriers)
  }
  return plan
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

async function readSiteIssues(db: Db, hostingId: string): Promise<NameOriginIssues> {
  const [site] = await db
    .select({ metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  return readNameOriginIssues(site?.metadata)
}

/**
 * Under the organization's lock: read the names that still wait (they may have
 * changed while the provider was called), record the reasons and pin. Only
 * database work happens here.
 */
async function recordOutcome(
  db: Db,
  ctx: RunContext,
  hostingId: string,
  state: RunState
): Promise<string[]> {
  const now = ctx.deps.now ?? new Date()
  return await organizationOriginLock(
    db,
    ctx.organizationId
  )(async (tx) => {
    const waiting = await waitingNames(tx, hostingId, ctx.organizationId)
    const previous = await readSiteIssues(tx, hostingId)
    const issues = nextIssues(previous, waiting, state, now)
    // The site row before the name rows, the order a save writes them in.
    if (JSON.stringify(issues) !== JSON.stringify(previous)) {
      await saveNameOriginIssues(tx, hostingId, issues)
    }
    return await pinNames(tx, hostingId, ctx.organizationId, state.pins)
  })
}

/** Remove reasons for names that no longer ask for the origin certificate. */
async function dropStaleIssues(db: Db, hostingId: string): Promise<void> {
  if (Object.keys(await readSiteIssues(db, hostingId)).length > 0) {
    await saveNameOriginIssues(db, hostingId, {})
  }
}

async function auditIssued(
  db: Db,
  hostingId: string,
  ctx: RunContext,
  issued: readonly IssuedAudit[]
): Promise<void> {
  await forEachSequential(issued, async (one) => {
    await recordAudit(db, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.deps.actor?.userId ?? null,
      actorEmail: ctx.deps.actor?.email ?? null,
      action: 'origin_certificate.issue',
      targetType: 'organization',
      targetId: one.tlsId,
      context: { carrierId: one.carrierId, zone: one.zone, scope: 'names', hostingId },
    })
  })
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
  const waiting = await waitingNames(db, hostingId, organizationId)
  if (waiting.length === 0) {
    await dropStaleIssues(db, hostingId)
    return none
  }
  const [site] = await db
    .select({ metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  if (!site || readHostingComposeOwner(site.metadata) !== null) return none
  const now = deps.now ?? new Date()
  const previous = readNameOriginIssues(site.metadata)
  const due = waiting.filter(
    (name) => !(deps.respectBackoff && nameOriginIssueWaiting(previous[name], now))
  )
  const ctx: RunContext = {
    organizationId,
    deps,
    registry: deps.registry ?? createTunnelAdapterRegistry(),
  }
  const state = await runGroups(db, ctx, await planDue(db, ctx, due))
  const pinned = await recordOutcome(db, ctx, hostingId, state)
  await auditIssued(db, hostingId, ctx, state.issued)
  return { pinned, failed: [...state.failures.keys()].toSorted(compareText) }
}

/** What the servers got from the hosting before the edit that is being answered. */
export type HostingBeforeEdit = Pick<HostingPinState, 'ipId' | 'options' | 'updatedAt'>

/**
 * The edit time the apply measures "changed since the last deploy" against. An
 * edit that only chose certificates (the options and the pinned address are as
 * they were) does not count as a change itself, so the time before it is used;
 * any other edit of the site keeps its own time and the apply leaves the pair
 * to the next deploy.
 */
function editTimeForApply(before: HostingBeforeEdit | null, after: HostingPinState): string {
  return before && leftServerFactsAlone(before, after) ? before.updatedAt : after.updatedAt
}

/**
 * The call the routes make: issue what the hosting's names wait for and, when
 * something was pinned, queue the hostings-only apply that sends the pair to
 * the servers (when that is not safe right now the pair goes with the next
 * deploy). `before` is the site as it was before the save that is being
 * answered. Never throws: a failure here must not undo the save or the attach
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
    before?: HostingBeforeEdit
  }
): Promise<NameOriginOutcome> {
  const none: NameOriginOutcome = { pinned: [], failed: [] }
  try {
    const site = await loadHostingPinState(db, params.hostingId)
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
          editedAt: editTimeForApply(params.before ?? null, site),
        },
        params.applyDeps ?? {
          commandQueue: getCommandQueue(c),
          registry: getDaemonCellRegistry(c),
        }
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

/** Due names read per pass, in the order they are tried. */
const NAME_ORIGIN_SWEEP_SCAN = 500

export type NameOriginSweepResult = {
  tried: number
  failed: number
  /** Sites that gained a certificate, to send to their servers. */
  pinned: { hostingId: string; organizationId: string; editedAt: string }[]
}

/** A time stored in a name's recorded reason, as a timestamp the database can order by. */
function recordedTime(field: 'nextTryAt' | 'failedAt') {
  return sql`(${hosting.metadata} #>> array[${NAME_ORIGIN_ISSUES_KEY}::text, ${hostname.hostname}::text, ${field}::text])::timestamptz`
}

export type NameOriginSweepDeps = {
  secrets: DerivedSecretsConfig | null
  registry?: TunnelAdapterRegistry
  now?: Date
  /** Test seams: look only at these hostings, and take this many per pass. */
  onlyHostingIds?: readonly string[]
  batch?: number
}

/**
 * The scheduled retry: hostings with a name set to the origin certificate and
 * no pin, whose recorded back-off has passed. The most overdue come first
 * (names never tried, then the earliest recorded retry time, then the earliest
 * failure), so a name that keeps failing cannot hold the others back. Each
 * runs the same step a save runs. It adds no timer; the Let's Encrypt retry
 * tick calls it. Without the data-encryption secrets it does nothing.
 */
export async function sweepNameOriginCertificates(
  db: Db,
  deps: NameOriginSweepDeps
): Promise<NameOriginSweepResult> {
  const out: NameOriginSweepResult = { tried: 0, failed: 0, pinned: [] }
  if (deps.secrets === null) return out
  const now = deps.now ?? new Date()
  const nextTry = recordedTime('nextTryAt')
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
    .where(
      and(
        eq(hostname.certificate, 'cloudflare_origin'),
        isNull(hostname.tlsId),
        sql`(${nextTry} is null or ${nextTry} <= ${now.toISOString()}::timestamptz)`,
        ...(deps.onlyHostingIds ? [inArray(hostname.hostingId, [...deps.onlyHostingIds])] : [])
      )
    )
    .orderBy(
      sql`${nextTry} asc nulls first`,
      sql`${recordedTime('failedAt')} asc nulls first`,
      asc(hostname.id)
    )
    .limit(NAME_ORIGIN_SWEEP_SCAN)
  const due = new Map<string, { organizationId: string; updatedAt: string }>()
  for (const row of rows) {
    const issue = readNameOriginIssues(row.metadata)[row.name]
    if (nameOriginIssueWaiting(issue, now) || due.has(row.hostingId)) continue
    due.set(row.hostingId, { organizationId: row.organizationId, updatedAt: row.updatedAt })
  }
  const batch = deps.batch ?? NAME_ORIGIN_SWEEP_BATCH
  await forEachSequential([...due].slice(0, batch), async ([id, site]) => {
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
