import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  parseRootExtension,
  readServiceTurbopanelExtension,
  TURBOPANEL_ROOT_EXTENSION_KEY,
  type ComposeDocument,
  type PrincipalSpec,
} from '../../lib/compose/index.ts'
import { environment, service, tenancy } from '../../lib/db/schema.ts'
import { ensureComposePrincipal, isUuid } from './store.ts'

/** Service ids linked to each principal (empty array when none). */
export async function loadServiceIdsByPrincipalIds(
  db: Db,
  principalIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  for (const id of principalIds) {
    map.set(id, [])
  }
  if (principalIds.length === 0) return map

  const rows = await db
    .select({
      principalId: tenancy.principalId,
      serviceId: tenancy.serviceId,
    })
    .from(tenancy)
    .where(inArray(tenancy.principalId, [...principalIds]))

  for (const row of rows) {
    const list = map.get(row.principalId) ?? []
    list.push(row.serviceId)
    map.set(row.principalId, list)
  }
  for (const [id, list] of map) {
    list.sort((a, b) => a.localeCompare(b))
    map.set(id, list)
  }
  return map
}

/**
 * True when every id is a service in an environment owned by `projectId`.
 * Empty list is valid.
 */
export async function servicesBelongToProject(
  db: Db,
  projectId: string,
  serviceIds: readonly string[],
): Promise<boolean> {
  if (serviceIds.length === 0) return true
  const unique = [...new Set(serviceIds)]
  if (unique.some((id) => !isUuid(id))) return false

  const rows = await db
    .select({ id: service.id })
    .from(service)
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .where(
      and(
        eq(environment.projectId, projectId),
        inArray(service.id, unique),
      ),
    )

  return rows.length === unique.length
}

/** Distinct principal ids that tenancy any service in the environment. */
export async function loadTenancyPrincipalIdsForEnvironment(
  db: Db,
  environmentId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ principalId: tenancy.principalId })
    .from(tenancy)
    .innerJoin(service, eq(tenancy.serviceId, service.id))
    .where(eq(service.environmentId, environmentId))

  return rows
    .map((row) => row.principalId)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Principal ids that tenancy each service in the environment
 * (empty array when none). Keys are service ids.
 */
export async function loadPrincipalIdsByServiceIdForEnvironment(
  db: Db,
  environmentId: string,
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({
      principalId: tenancy.principalId,
      serviceId: tenancy.serviceId,
    })
    .from(tenancy)
    .innerJoin(service, eq(tenancy.serviceId, service.id))
    .where(eq(service.environmentId, environmentId))

  const map = new Map<string, string[]>()
  for (const row of rows) {
    const list = map.get(row.serviceId) ?? []
    list.push(row.principalId)
    map.set(row.serviceId, list)
  }
  for (const [serviceId, list] of map) {
    list.sort((a, b) => a.localeCompare(b))
    map.set(serviceId, list)
  }
  return map
}

/** Result of picking at most one principal for a site ownership pin. */
export type SolePrincipalPick =
  | { status: 'none' }
  | { status: 'one'; principalId: string }
  | { status: 'ambiguous' }

/**
 * Pick the single principal for a site service ownership pin.
 * Zero → `{ status: 'none' }`; one → that principal; more than one → ambiguous.
 */
export function pickSolePrincipalId(
  principalIds: readonly string[],
): SolePrincipalPick {
  if (principalIds.length === 0) return { status: 'none' }
  const [sole] = principalIds
  if (principalIds.length === 1 && sole !== undefined) {
    return { status: 'one', principalId: sole }
  }
  return { status: 'ambiguous' }
}

export function parseServiceIdsField(body: Record<string, unknown>): string[] | null {
  if (!('serviceIds' in body)) return []
  const raw = body.serviceIds
  if (!Array.isArray(raw)) return null
  const ids: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isUuid(entry.trim())) return null
    ids.push(entry.trim())
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}


/**
 * What one compose document says about ownership, once its aliases have been
 * materialized into real `principal` rows.
 *
 * Two maps rather than one because the two lanes ask different questions: the
 * site lane holds a `SiteSpec` and needs "which account does this compose
 * service run as", while the source lane resolves per binding. Both go through
 * the alias, which is the only thing either lane and the document agree on.
 */
export type ComposePrincipalResolution = {
  /** Declared alias → the `principal.id` it materialized into. */
  principalIdByAlias: ReadonlyMap<string, string>
  /** Compose service name → the alias its `x-turbopanel.principal` names. */
  aliasByComposeServiceName: ReadonlyMap<string, string>
}

export type ComposePrincipalReconcileResult =
  | { ok: true; resolution: ComposePrincipalResolution }
  /** A service names an alias the document's root never declared. */
  | { ok: false; composeServiceName: string; alias: string }

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every `x-turbopanel.principal` in a merged document, in stable key order. */
function collectDeclaredAliases(
  merged: ComposeDocument,
): Map<string, string> {
  const services = isPlainMapping(merged.data.services)
    ? merged.data.services
    : {}
  const out = new Map<string, string>()
  for (const name of Object.keys(services).toSorted((a, b) => a.localeCompare(b))) {
    const raw = services[name]
    if (!isPlainMapping(raw)) continue
    const alias = readServiceTurbopanelExtension(raw)?.principal
    if (alias) out.set(name, alias)
  }
  return out
}

/**
 * Materialize the accounts a compose document declares, and link them to the
 * services that name them.
 *
 * Runs at deploy-prepare, immediately after `reconcileServicesFromCompose` has
 * written the service rows this needs ids from, and **before** either ownership
 * lane resolves — an alias that had not become a `principal` row by then would
 * silently produce an unowned site or an unreleased app, which is the failure
 * this whole field exists to remove.
 *
 * **Additive only.** A tenancy edge created some other way (an operator
 * assigning a principal in the UI) is never deleted here: "the declared alias
 * wins" is a statement about *resolution*, and resolution is where it is
 * enforced — see `attachPrincipalsToSites` and `resolveBindingPrincipal`.
 * Destroying edges to make the document the only truth would delete ownership
 * an operator deliberately added to a document that never mentions it.
 *
 * Errors propagate rather than being swallowed: unlike
 * `enqueuePrincipalsReconcile`, nothing has succeeded yet that a failure here
 * would misreport, and a half-materialized alias set is exactly the state the
 * lanes must never see.
 */
export async function reconcilePrincipalsFromCompose(
  db: Db,
  params: {
    organizationId: string
    projectId: string
    merged: ComposeDocument
    serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>
  },
): Promise<ComposePrincipalReconcileResult> {
  const aliasByComposeServiceName = collectDeclaredAliases(params.merged)
  if (aliasByComposeServiceName.size === 0) {
    return {
      ok: true,
      resolution: {
        principalIdByAlias: new Map(),
        aliasByComposeServiceName,
      },
    }
  }

  const root = parseRootExtension(
    (params.merged.data as Record<string, unknown>)[
      TURBOPANEL_ROOT_EXTENSION_KEY
    ],
  )
  const specs: Record<string, PrincipalSpec> = root?.principals ?? {}

  // Defense in depth. The linter refuses this at save, so reaching it means the
  // document predates the rule or was written past the API — either way the
  // deploy must say so rather than quietly running the service as nobody.
  for (const [composeServiceName, alias] of aliasByComposeServiceName) {
    if (!(alias in specs)) {
      return { ok: false, composeServiceName, alias }
    }
  }

  const serviceIdByComposeName = new Map(
    params.serviceRows.map((row) => [row.composeServiceName, row.id]),
  )

  const principalIdByAlias = new Map<string, string>()
  for (
    const alias of [...new Set(aliasByComposeServiceName.values())].sort(
      (a, b) => a.localeCompare(b),
    )
  ) {
    const spec = specs[alias]
    const { principalId } = await ensureComposePrincipal(db, {
      organizationId: params.organizationId,
      projectId: params.projectId,
      alias,
      ...(spec.access === undefined ? {} : { access: spec.access }),
    })
    principalIdByAlias.set(alias, principalId)
  }

  const edges: { principalId: string; serviceId: string }[] = []
  for (const [composeServiceName, alias] of aliasByComposeServiceName) {
    const serviceId = serviceIdByComposeName.get(composeServiceName)
    const principalId = principalIdByAlias.get(alias)
    if (!serviceId || !principalId) continue
    edges.push({ principalId, serviceId })
  }
  if (edges.length > 0) {
    await db.insert(tenancy).values(edges).onConflictDoNothing()
  }

  return {
    ok: true,
    resolution: { principalIdByAlias, aliasByComposeServiceName },
  }
}
