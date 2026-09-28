/**
 * Hardware-profile reads, the NIC-slot-limit resolution, and the
 * merge/persist/push write path — shared by the settings route
 * (`src/client/servers/metrics-routes.ts`) and anything else that needs to
 * read or update a server's operator-assigned hardware profile (e.g.
 * `src/features/servers/nic-auto-monitor.ts`). Lives here, not on the route
 * file, so a feature module can depend on it without crossing the
 * feature → surface boundary (`scripts/check-import-boundaries.mjs`).
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { getDaemonCellRegistry } from '../../db/connection.ts'
import { organization, server, tier } from '../../db/schema.ts'
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
} from '../../contracts/cell-protocol.ts'
import { cellTrace } from '../../lib/logger.ts'
import {
  type MetricsCapabilityTierEntitlements,
  type MetricsDeploymentKind,
  resolveServerMachineClass,
} from '../../contracts/capability-plan.ts'
import { metricsCapabilityTierEntitlementsForRank } from '../tiers/tier-entitlements.ts'
import { parseOrganizationOptions } from '../organizations/organization-options.ts'
import {
  mergeServerHardwareProfile,
  parseServerHardwareProfile,
  parseServerHostResources,
  parseServerOptions,
  resolveEffectiveMetricsCapabilityPlan,
  type ServerHardwareProfile,
  type ServerHardwareProfileUpdate,
} from './server-metadata.ts'

/**
 * Server-metadata facts a single-server metrics route needs before it can
 * even build its cache key: the operator-assigned hardware profile (whose
 * `generation` scopes the cache key — see `metricsChartCacheKey`) and the
 * organization id (for the temperature-unit lookup on a cache miss). One
 * lightweight query — never called from `/servers/metrics/latest`, where
 * doing this per fleet server would break the O(1) fleet-read invariant.
 */
export async function loadServerHardwareProfile(
  db: Db,
  serverId: string
): Promise<{
  hardwareProfile: ServerHardwareProfile | undefined
  organizationId: string | null
  serverOptions: ReturnType<typeof parseServerOptions>
  /** Declared `server.machine_class`; `null` until pinned or inferred physical. */
  machineClass: string | null
}> {
  const [serverRow] = await db
    .select({
      metadata: server.metadata,
      organizationId: server.organizationId,
      options: server.options,
      machineClass: server.machineClass,
    })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const rawMetadata = serverRow?.metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {}
  const hardwareProfile = parseServerHardwareProfile(metadata.hardwareProfile)
  const resources = parseServerHostResources(metadata.resources)

  // `hardwareProfile.cpuModel` is only ever written by a host-facts
  // projection this codebase does not have yet — fall back to the raw
  // `/proc/cpuinfo` model name the daemon already reports on every
  // hello/heartbeat (`resources.cpus[0].name`) so CPU-catalog lookups
  // resolve on real hosts instead of only in tests that set cpuModel by
  // hand. Never persisted — a per-request derivation only.
  const detectedCpuModel = resources?.cpus?.[0]?.name
  const effectiveHardwareProfile =
    hardwareProfile?.cpuModel || !detectedCpuModel
      ? hardwareProfile
      : { ...hardwareProfile, cpuModel: detectedCpuModel }

  return {
    hardwareProfile: effectiveHardwareProfile,
    organizationId: serverRow?.organizationId ?? null,
    serverOptions: parseServerOptions(serverRow?.options),
    machineClass: serverRow?.machineClass ?? null,
  }
}

/** One organization-options read, shared by the envelope and the NIC-slot limit. */
export async function loadOrganizationOptions(db: Db, organizationId: string | null) {
  if (!organizationId) return null
  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return parseOrganizationOptions(orgRow?.options)
}

/**
 * Hosted-only `server.assigned_tier_id → tier` join. Self-hosted never
 * looks up a tier so ingest and the read-side envelope stay uncapped on
 * that path. A hosted server assigned nothing resolves to the platform
 * default plan, the same as ingest.
 */
export async function loadServerTierEntitlements(
  db: Db,
  serverId: string,
  deployment: MetricsDeploymentKind
): Promise<MetricsCapabilityTierEntitlements | undefined> {
  if (deployment === 'self-hosted') return undefined
  const [row] = await db
    .select({ rank: tier.rank })
    .from(server)
    .innerJoin(tier, eq(tier.id, server.assignedTierId))
    .where(eq(server.id, serverId))
    .limit(1)
  return metricsCapabilityTierEntitlementsForRank(row?.rank)
}

/**
 * The server's effective monitored-NIC slot limit — `normalNicSlots` of its
 * resolved capability plan (tier-derived or platform default for this
 * deployment → org → server override), classified physical/virtual from the
 * declared `server.machine_class` column — falling back to its latest
 * recorded topology — the same way ingest does. The single source the
 * settings PUT validates against and the envelope reports to the UI.
 */
export function resolveNicSlotLimit(
  inputs: Readonly<{
    machineClass: string | null
    latestSnapshot: unknown
    orgOptions: ReturnType<typeof parseOrganizationOptions> | null
    serverOptions: ReturnType<typeof parseServerOptions>
    deployment: MetricsDeploymentKind
    tier?: MetricsCapabilityTierEntitlements
  }>
): number {
  return resolveEffectiveMetricsCapabilityPlan(
    resolveServerMachineClass(inputs.machineClass, inputs.latestSnapshot),
    inputs.orgOptions ?? undefined,
    inputs.serverOptions ?? undefined,
    inputs.deployment,
    inputs.tier
  ).normalNicSlots
}

export type HardwareProfilePersistResult =
  | { notFound: true }
  | {
      notFound: false
      merged: ServerHardwareProfile | undefined
    }

export async function mergeAndPersistHardwareProfile(
  db: Db,
  serverId: string,
  update: ServerHardwareProfileUpdate
): Promise<HardwareProfilePersistResult> {
  const rows = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (rows.length === 0) {
    return { notFound: true }
  }

  const rawMetadata = rows[0].metadata
  const metadata: Record<string, unknown> =
    rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {}
  const existing = parseServerHardwareProfile(metadata.hardwareProfile)
  const { profile: merged } = mergeServerHardwareProfile(existing, update, new Date().toISOString())
  // Patch only the hardwareProfile subtree in SQL — the daemon projects
  // resources / docker / geo onto the same column concurrently, so a full
  // read-modify-write of `metadata` could write back a stale object and
  // drop keys a heartbeat landed between our SELECT and UPDATE.
  await db
    .update(server)
    .set({
      metadata: merged
        ? sql`jsonb_set(COALESCE(${server.metadata}, '{}'::jsonb), '{hardwareProfile}', ${JSON.stringify(
            merged
          )}::jsonb)`
        : sql`COALESCE(${server.metadata}, '{}'::jsonb) - 'hardwareProfile'`,
    })
    .where(eq(server.id, serverId))

  return { notFound: false, merged }
}

export async function pushHardwareProfileUpdate(
  registry: ReturnType<typeof getDaemonCellRegistry>,
  serverId: string,
  merged: ServerHardwareProfile | undefined
): Promise<boolean> {
  if (!registry) return false

  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'topology-overrides-update',
    deliveryId: generateDeliveryId(),
    requestId,
    overrides: merged ?? {},
    at: new Date().toISOString(),
  }
  cellTrace('request-start', {
    requestId,
    serverId,
    kind: 'topology-overrides-update',
  })
  try {
    await registry.getCell(serverId).enqueue(envelope)
    cellTrace('request-enqueued', {
      requestId,
      serverId,
      kind: 'topology-overrides-update',
      deliveryId: envelope.deliveryId,
    })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'topology-overrides-update',
      resultStatus: 'error',
      error: message,
    })
    return false
  }
}
