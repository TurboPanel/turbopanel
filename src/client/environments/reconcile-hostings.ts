/**
 * Materialize `x-turbopanel.hosting` into `hosting` rows.
 *
 * The compose half of the ingress story ends here. Everything downstream —
 * `buildHostingsForService` / `resolveHttpHostingEntry` in `./deploy-routes.ts`,
 * the hosting helpers in `./deploy-prepare.ts`, and the daemon's ingress, site,
 * and TLS lanes — keeps reading `hosting` rows exactly as it always has and
 * never learns that compose exists. That is the whole point of doing the work
 * as a *reconcile* rather than a new payload shape: one authoring surface was
 * added, and no consumer changed.
 *
 * Runs at deploy-prepare immediately after `reconcileServicesFromCompose` has
 * written the `service` rows this needs ids from, and before the hosting
 * fan-out reads them.
 *
 * ## What compose owns, and what it does not
 *
 * A row this module creates is stamped `metadata.composeOwned` (see
 * `../../lib/hosting-compose-owner.ts`) and from then on compose is the truth
 * for the *route*: hostname, path prefix, target port, forced HTTPS, bind
 * scope, and the TLS pin. Everything else on the row — `web.env`, the PHP
 * hints, `description`, raw `tcp`/`udp` port mappings — is panel-authored, has
 * no compose spelling, and is preserved across every reconcile.
 *
 * Rows **without** the marker are never created or pruned here, with exactly
 * one exception: a panel-authored row on the same service that already routes
 * the *same* `(hostname, pathPrefix)` a declaration names. Leaving that row
 * alone would mint a second row for one route, and `validateDeployHostings`
 * refuses a duplicate hostname/path combination — so a document that merely
 * wrote down a route the panel already served would break the deploy. Such a
 * row is **adopted** instead: stamped with the marker (and with
 * `composeAdopted`, so a later prune *releases* it back to the panel rather
 * than deleting an operator's row) and re-asserted from the declaration, with
 * every panel-only field preserved. Everything else without the marker stays
 * untouched, which is what makes this additive rather than a migration.
 */

import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  DEFAULT_HOSTING_PATH_PREFIX,
  hostingBindScopeOf,
  hostingEntryKey,
  hostingPathPrefixOf,
  hostingTargetPortAuthorable,
  hostingTlsModeOf,
  readServiceTurbopanelExtension,
  type ComposeDocument,
  type ComposeHostingExtensionEntry,
  type ComposeHostingTlsMode,
  type ComposeServiceKind,
} from '../../lib/compose/index.ts'
import { hosting, ip, service, tls } from '../../lib/db/schema.ts'
import {
  HOSTING_COMPOSE_ROUTE_METADATA_KEY,
  isAdoptedComposeHosting,
  isComposeOwnedHosting,
  withHostingComposeOwner,
  withoutHostingComposeOwner,
} from '../../lib/hosting-compose-owner.ts'
import {
  parseHostingOptions,
  type HostingOptions,
} from '../../lib/hosting-options.ts'

/**
 * A ref named a row this organization does not have.
 *
 * Two kinds rather than one so the deploy response can say which side failed,
 * and a `reason` because "there is no such certificate" and "there are two
 * certificates by that name" are different problems with different fixes.
 * Neither is ever resolved by silently nulling the pin: a route that quietly
 * downgrades from a pinned certificate to a self-signed one is the failure this
 * error exists to prevent.
 */
export type ComposeHostingRefError = {
  kind: 'hosting_tls_ref_unresolved' | 'hosting_ip_ref_unresolved'
  composeServiceName: string
  hostname: string
  ref: string
  reason: 'not_found' | 'ambiguous'
}

/**
 * An entry asked for a TLS mode nothing downstream can perform.
 *
 * Today that is `tls.mode: automatic`. The deploy payload's only TLS field is
 * `EnvironmentDeployHosting.tlsId` — a resolved pin, or null meaning Caddy
 * `tls internal` — so "obtain a certificate for me" has no wire spelling, and
 * projecting it as a null pin would serve a self-signed certificate to an
 * operator who asked for a real one. Refused here for the same reason
 * {@link ComposeHostingRefError} is: a quiet TLS downgrade is worse than a
 * loud refusal. The save-time linter refuses it first; reaching here means the
 * document was written before that rule existed.
 */
export type ComposeHostingTlsModeError = {
  kind: 'hosting_tls_mode_unsupported'
  composeServiceName: string
  hostname: string
  mode: ComposeHostingTlsMode
}

/**
 * A declaration names a route a panel-authored row already serves, and that row
 * cannot be adopted because it serves other hostnames too.
 *
 * Adopting it would silently drop those other hostnames; leaving it alone would
 * mint a second row for the same `(serviceId, hostname, pathPrefix)`, which
 * `validateDeployHostings` refuses much later with nothing said about which two
 * configuration sources collided. So the collision is reported here, naming the
 * row and the hostnames it would have lost.
 */
export type ComposeHostingRouteConflictError = {
  kind: 'hosting_route_conflict'
  composeServiceName: string
  hostname: string
  pathPrefix: string
  /** The panel-authored row already serving this route. */
  hostingId: string
  /** Hostnames that row serves besides the declared one. */
  otherHostnames: string[]
}

export type ComposeHostingError =
  | ComposeHostingRefError
  | ComposeHostingTlsModeError
  | ComposeHostingRouteConflictError

export type ComposeHostingReconcileResult =
  | {
    ok: true
    /** `hosting.id` of rows this pass minted. */
    created: string[]
    /** `hosting.id` of compose-owned rows this pass re-asserted. */
    updated: string[]
    /** `hosting.id` of panel rows this pass took over for a matching route. */
    adopted: string[]
    /** `hosting.id` of compose-owned rows whose declaration disappeared. */
    removed: string[]
    /** `hosting.id` of adopted rows handed back to the panel. */
    released: string[]
  }
  | { ok: false; error: ComposeHostingError }

type DeclaredRoute = {
  composeServiceName: string
  entry: ComposeHostingExtensionEntry
  /**
   * The kind the service declares, because two route fields are gated on it:
   * `targetPort` is only authorable on a container ({@link
   * hostingTargetPortAuthorable}), and a `site` / `node` route is answered on
   * a loopback port TurboPanel allocates.
   */
  serviceKind: ComposeServiceKind | undefined
  /** {@link hostingEntryKey} for the entry — the row's compose identity. */
  route: string
}

type ExistingRow = {
  id: string
  serviceId: string
  metadata: unknown
  options: unknown
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every declared route in a merged document, in stable order.
 *
 * Sorted by compose service name, then by declaration order within the service,
 * so a reconcile of an unchanged document issues the same statements in the
 * same sequence every time.
 */
function collectDeclaredRoutes(merged: ComposeDocument): DeclaredRoute[] {
  const services = isPlainMapping(merged.data.services)
    ? merged.data.services
    : {}
  const routes: DeclaredRoute[] = []
  for (
    const composeServiceName of Object.keys(services).toSorted((a, b) =>
      a.localeCompare(b)
    )
  ) {
    const raw = services[composeServiceName]
    if (!isPlainMapping(raw)) continue
    const extension = readServiceTurbopanelExtension(raw)
    const entries = extension?.hosting
    if (!entries) continue
    for (const entry of entries) {
      routes.push({
        composeServiceName,
        entry,
        serviceKind: extension?.serviceKind,
        route: hostingEntryKey(entry),
      })
    }
  }
  return routes
}

/** Refs, deduped, in the order the document names them. */
function collectRefs(
  routes: readonly DeclaredRoute[],
  read: (entry: ComposeHostingExtensionEntry) => string | undefined,
): string[] {
  const refs: string[] = []
  const seen = new Set<string>()
  for (const route of routes) {
    const ref = read(route.entry)
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    refs.push(ref)
  }
  return refs
}

/**
 * Ref → row id for an organization's reference table.
 *
 * A ref may spell the row's id **or** its human label (a `tls` name, an `ip`
 * address), because an operator writing YAML has the label in front of them and
 * not a UUID. A label two rows share resolves to neither — picking one would be
 * a coin flip about which certificate serves production traffic.
 */
type RefResolution =
  | { kind: 'ok'; id: string }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' }

function buildRefIndex(
  rows: ReadonlyArray<{ id: string; label: string | null }>,
): (ref: string) => RefResolution {
  const byId = new Map<string, string>()
  const byLabel = new Map<string, string[]>()
  for (const row of rows) {
    byId.set(row.id, row.id)
    const label = row.label?.trim()
    if (!label) continue
    const list = byLabel.get(label) ?? []
    list.push(row.id)
    byLabel.set(label, list)
  }
  return (ref: string): RefResolution => {
    const byIdMatch = byId.get(ref)
    if (byIdMatch) return { kind: 'ok', id: byIdMatch }
    const matches = byLabel.get(ref) ?? []
    if (matches.length === 1) return { kind: 'ok', id: matches[0] }
    if (matches.length > 1) return { kind: 'ambiguous' }
    return { kind: 'not_found' }
  }
}

async function loadTlsIndex(
  db: Db,
  organizationId: string,
  needed: boolean,
): Promise<(ref: string) => RefResolution> {
  if (!needed) return () => ({ kind: 'not_found' })
  const rows = await db
    .select({ id: tls.id, label: tls.name })
    .from(tls)
    .where(eq(tls.organizationId, organizationId))
  return buildRefIndex(rows)
}

async function loadIpIndex(
  db: Db,
  organizationId: string,
  needed: boolean,
): Promise<(ref: string) => RefResolution> {
  if (!needed) return () => ({ kind: 'not_found' })
  const rows = await db
    .select({ id: ip.id, label: ip.address })
    .from(ip)
    .where(eq(ip.organizationId, organizationId))
  return buildRefIndex(rows)
}

/**
 * The route fields compose owns, written over whatever the row already held.
 *
 * A merge rather than a replacement: `web`, `protocol`, and `ports` have no
 * compose spelling, so overwriting the whole object would silently delete an
 * operator's PHP hints the first time a deploy ran. Conversely every field
 * compose *does* author is asserted, including by deletion — an entry that
 * stops naming `targetPort` means "no pinned target", not "keep the old one".
 *
 * `targetPort` is only authored on a `container`. On a `site` or a `node` the
 * listen port is allocated by TurboPanel and read back by the daemon off
 * `sites[]` / `nativeAppServices[]`, so a value that reached here anyway (an
 * older document, saved before the rule existed) is **dropped** rather than
 * persisted — persisting it would give the port allocator a second source of
 * truth by way of `preferredListenPortsFromHostings`.
 */
function mergeComposeHostingOptions(
  existing: unknown,
  entry: ComposeHostingExtensionEntry,
  serviceKind: ComposeServiceKind | undefined,
): HostingOptions {
  const options: HostingOptions = { ...parseHostingOptions(existing) }

  options.hostnames = [entry.hostname]
  options.pathPrefix = hostingPathPrefixOf(entry)
  options.bind = hostingBindScopeOf(entry)

  if (
    entry.targetPort === undefined || !hostingTargetPortAuthorable(serviceKind)
  ) {
    delete options.targetPort
  } else {
    options.targetPort = entry.targetPort
  }

  const proxy = { ...options.proxy }
  if (entry.forceHttps === undefined) {
    delete proxy.forceHttps
  } else {
    proxy.forceHttps = entry.forceHttps
  }
  if (Object.keys(proxy).length > 0) {
    options.proxy = proxy
  } else {
    delete options.proxy
  }

  return options
}

function refErrorFor(
  kind: ComposeHostingRefError['kind'],
  route: DeclaredRoute,
  ref: string,
  resolution: Extract<RefResolution, { kind: 'not_found' | 'ambiguous' }>,
): ComposeHostingRefError {
  return {
    kind,
    composeServiceName: route.composeServiceName,
    hostname: route.entry.hostname,
    ref,
    reason: resolution.kind,
  }
}

/**
 * Every `hosting` row on this environment's services, split by provenance.
 *
 * Panel rows are loaded too — not to touch them wholesale, but because a
 * declaration that names a route one of them already serves has to be resolved
 * here (adopted or reported) rather than left to collide in
 * `validateDeployHostings` two steps later.
 */
async function loadEnvironmentHostingRows(
  db: Db,
  environmentId: string,
): Promise<{ composeOwned: ExistingRow[]; panelAuthored: ExistingRow[] }> {
  const rows = await db
    .select({
      id: hosting.id,
      serviceId: hosting.serviceId,
      metadata: hosting.metadata,
      options: hosting.options,
    })
    .from(hosting)
    .innerJoin(service, eq(hosting.serviceId, service.id))
    .where(eq(service.environmentId, environmentId))

  const composeOwned: ExistingRow[] = []
  const panelAuthored: ExistingRow[] = []
  for (const row of rows) {
    if (isComposeOwnedHosting(row.metadata)) composeOwned.push(row)
    else panelAuthored.push(row)
  }
  return { composeOwned, panelAuthored }
}

/**
 * How a panel-authored row answers a declared route.
 *
 * `adopt` when the row routes exactly that one hostname on that prefix — the
 * declaration and the row say the same thing, so the row *is* the route and
 * taking it over is lossless. `conflict` when the row also serves other
 * hostnames: rewriting `hostnames` to the declared one alone would silently
 * stop serving the rest, and minting a second row would fail the deploy.
 */
type PanelRowMatch =
  | { kind: 'none' }
  | { kind: 'adopt'; row: ExistingRow }
  | { kind: 'conflict'; row: ExistingRow; otherHostnames: string[] }

function matchPanelAuthoredRow(
  rows: readonly ExistingRow[],
  params: {
    serviceId: string
    hostname: string
    pathPrefix: string
    excludeIds: ReadonlySet<string>
  },
): PanelRowMatch {
  for (const row of rows) {
    if (row.serviceId !== params.serviceId) continue
    if (params.excludeIds.has(row.id)) continue
    const options = parseHostingOptions(row.options)
    if (options === null) continue
    // A tcp/udp publish has no hostnames and can never be the same route.
    if ((options.protocol ?? 'http') !== 'http') continue
    const hostnames = options.hostnames ?? []
    if (!hostnames.includes(params.hostname)) continue
    if ((options.pathPrefix ?? DEFAULT_HOSTING_PATH_PREFIX) !== params.pathPrefix) {
      continue
    }
    const otherHostnames = hostnames.filter((name) => name !== params.hostname)
    if (otherHostnames.length > 0) {
      return { kind: 'conflict', row, otherHostnames }
    }
    return { kind: 'adopt', row }
  }
  return { kind: 'none' }
}

function existingRowKey(serviceId: string, route: string): string {
  return `${serviceId} ${route}`
}

function readRouteFromMetadata(metadata: unknown): string | null {
  if (!isPlainMapping(metadata)) return null
  const route = metadata[HOSTING_COMPOSE_ROUTE_METADATA_KEY]
  return typeof route === 'string' ? route : null
}

/** Everything one declared route needs to be upserted, plus the outcome lists. */
type RouteReconcileContext = {
  serviceIdByComposeName: ReadonlyMap<string, string>
  resolveTls: (ref: string) => RefResolution
  resolveIp: (ref: string) => RefResolution
  panelAuthored: readonly ExistingRow[]
  existingByKey: Map<string, ExistingRow>
  keptIds: Set<string>
  created: string[]
  updated: string[]
  adopted: string[]
}

/**
 * Upsert the `hosting` row for one declared route.
 *
 * Records the outcome (created / updated / adopted, plus the kept row) on
 * `ctx`, and returns the error that stops the whole reconcile — or `null`.
 */
async function reconcileDeclaredRoute(
  db: Db,
  route: DeclaredRoute,
  ctx: RouteReconcileContext,
): Promise<ComposeHostingError | null> {
  const serviceId = ctx.serviceIdByComposeName.get(route.composeServiceName)
  // A service with no row is a service `reconcileServicesFromCompose` did not
  // see — impossible for a merged document, and not something to invent a
  // hosting for if it ever happens.
  if (!serviceId) return null

  const modeError = unsupportedTlsModeError(route)
  if (modeError) return modeError

  const pins = resolvePins(route, ctx.resolveTls, ctx.resolveIp)
  if (!pins.ok) return pins.error

  let existing = ctx.existingByKey.get(existingRowKey(serviceId, route.route))
  let isAdoption = false
  if (!existing) {
    const match = matchPanelAuthoredRow(ctx.panelAuthored, {
      serviceId,
      hostname: route.entry.hostname,
      pathPrefix: hostingPathPrefixOf(route.entry),
      excludeIds: ctx.keptIds,
    })
    if (match.kind === 'conflict') {
      return {
        kind: 'hosting_route_conflict',
        composeServiceName: route.composeServiceName,
        hostname: route.entry.hostname,
        pathPrefix: hostingPathPrefixOf(route.entry),
        hostingId: match.row.id,
        otherHostnames: match.otherHostnames,
      }
    }
    if (match.kind === 'adopt') {
      existing = match.row
      isAdoption = true
    }
  }

  const options = mergeComposeHostingOptions(
    existing?.options,
    route.entry,
    route.serviceKind,
  )
  const metadata = withHostingComposeOwner(existing?.metadata, {
    composeServiceName: route.composeServiceName,
    route: route.route,
    tlsMode: hostingTlsModeOf(route.entry),
    ...(isAdoption ? { adopted: true } : {}),
  })

  if (existing) {
    await db
      .update(hosting)
      .set({
        name: route.entry.hostname,
        tlsId: pins.tlsId,
        ipId: pins.ipId,
        metadata,
        options,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(hosting.id, existing.id))
    if (isAdoption) ctx.adopted.push(existing.id)
    else ctx.updated.push(existing.id)
    ctx.keptIds.add(existing.id)
    ctx.existingByKey.set(existingRowKey(serviceId, route.route), {
      id: existing.id,
      serviceId,
      metadata,
      options,
    })
    return null
  }

  const [inserted] = await db
    .insert(hosting)
    .values({
      name: route.entry.hostname,
      serviceId,
      tlsId: pins.tlsId,
      ipId: pins.ipId,
      metadata,
      options,
    })
    .returning({ id: hosting.id })
  ctx.created.push(inserted.id)
  ctx.keptIds.add(inserted.id)
  ctx.existingByKey.set(existingRowKey(serviceId, route.route), {
    id: inserted.id,
    serviceId,
    metadata,
    options,
  })
  return null
}

/**
 * Retire compose-owned rows whose declaration disappeared.
 *
 * An adopted row outlived its declaration: hand it back to the panel intact
 * rather than deleting a route the operator built before compose named it.
 * Everything else compose minted itself is deleted.
 */
async function pruneOrphanedComposeRows(
  db: Db,
  existingRows: readonly ExistingRow[],
  keptIds: ReadonlySet<string>,
): Promise<{ removed: string[]; released: string[] }> {
  const orphaned = existingRows.filter((row) => !keptIds.has(row.id))
  const releasedRows = orphaned.filter((row) =>
    isAdoptedComposeHosting(row.metadata)
  )
  for (const row of releasedRows) {
    await db
      .update(hosting)
      .set({
        metadata: withoutHostingComposeOwner(row.metadata),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(hosting.id, row.id))
  }
  const released = releasedRows.map((row) => row.id)

  const removed = orphaned
    .filter((row) => !isAdoptedComposeHosting(row.metadata))
    .map((row) => row.id)
  if (removed.length > 0) {
    await db.delete(hosting).where(inArray(hosting.id, removed))
  }

  return { removed, released }
}

/**
 * Ensure every declared route has a `hosting` row, and that no compose-owned
 * row outlives its declaration.
 *
 * Idempotent: a second call on an unchanged document creates nothing, removes
 * nothing, and re-asserts the same values. Errors are returned rather than
 * thrown so the caller can turn them into a deploy-prepare refusal with the
 * compose service name and hostname the operator actually typed.
 */
export async function reconcileHostingsFromCompose(
  db: Db,
  params: {
    organizationId: string
    environmentId: string
    merged: ComposeDocument
    serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>
  },
): Promise<ComposeHostingReconcileResult> {
  const routes = collectDeclaredRoutes(params.merged)
  const { composeOwned: existingRows, panelAuthored } =
    await loadEnvironmentHostingRows(db, params.environmentId)
  if (routes.length === 0 && existingRows.length === 0) {
    return {
      ok: true,
      created: [],
      updated: [],
      adopted: [],
      removed: [],
      released: [],
    }
  }

  const tlsRefs = collectRefs(routes, (entry) => entry.tls?.certificateRef)
  const ipRefs = collectRefs(routes, (entry) => entry.bind?.ipRef)
  const resolveTls = await loadTlsIndex(
    db,
    params.organizationId,
    tlsRefs.length > 0,
  )
  const resolveIp = await loadIpIndex(
    db,
    params.organizationId,
    ipRefs.length > 0,
  )

  const serviceIdByComposeName = new Map(
    params.serviceRows.map((row) => [row.composeServiceName, row.id]),
  )
  const existingByKey = new Map<string, ExistingRow>()
  for (const row of existingRows) {
    const route = readRouteFromMetadata(row.metadata)
    if (route === null) continue
    existingByKey.set(existingRowKey(row.serviceId, route), row)
  }

  const ctx: RouteReconcileContext = {
    serviceIdByComposeName,
    resolveTls,
    resolveIp,
    panelAuthored,
    existingByKey,
    keptIds: new Set<string>(),
    created: [],
    updated: [],
    adopted: [],
  }

  for (const route of routes) {
    const error = await reconcileDeclaredRoute(db, route, ctx)
    if (error) return { ok: false, error }
  }

  const { removed, released } = await pruneOrphanedComposeRows(
    db,
    existingRows,
    ctx.keptIds,
  )

  return {
    ok: true,
    created: ctx.created,
    updated: ctx.updated,
    adopted: ctx.adopted,
    removed,
    released,
  }
}

/**
 * The refusal for a mode the deploy cannot perform, or nothing.
 *
 * Only `automatic` today. Split out rather than inlined so the reason lives
 * next to {@link ComposeHostingTlsModeError} rather than in the middle of the
 * upsert loop.
 */
function unsupportedTlsModeError(
  route: DeclaredRoute,
): ComposeHostingTlsModeError | null {
  const mode = hostingTlsModeOf(route.entry)
  if (mode !== 'automatic') return null
  return {
    kind: 'hosting_tls_mode_unsupported',
    composeServiceName: route.composeServiceName,
    hostname: route.entry.hostname,
    mode,
  }
}

type ResolvedPins =
  | { ok: true; tlsId: string | null; ipId: string | null }
  | { ok: false; error: ComposeHostingRefError }

/**
 * The `tls_id` / `ip_id` one entry pins.
 *
 * `tls.mode: internal` pins nothing — Caddy's own self-signed certificate needs
 * no row from the library. `automatic` never reaches here: it is refused by
 * {@link unsupportedTlsModeError} above, because a null pin would deploy as
 * `tls internal` and quietly answer a request for a managed certificate with a
 * self-signed one. The authored mode is still recorded in metadata rather than
 * inferred back from a null column.
 */
function resolvePins(
  route: DeclaredRoute,
  resolveTls: (ref: string) => RefResolution,
  resolveIp: (ref: string) => RefResolution,
): ResolvedPins {
  let tlsId: string | null = null
  const certificateRef = route.entry.tls?.certificateRef
  if (certificateRef) {
    const resolution = resolveTls(certificateRef)
    if (resolution.kind !== 'ok') {
      return {
        ok: false,
        error: refErrorFor(
          'hosting_tls_ref_unresolved',
          route,
          certificateRef,
          resolution,
        ),
      }
    }
    tlsId = resolution.id
  }

  let ipId: string | null = null
  const ipRef = route.entry.bind?.ipRef
  if (ipRef) {
    const resolution = resolveIp(ipRef)
    if (resolution.kind !== 'ok') {
      return {
        ok: false,
        error: refErrorFor('hosting_ip_ref_unresolved', route, ipRef, resolution),
      }
    }
    ipId = resolution.id
  }

  return { ok: true, tlsId, ipId }
}
