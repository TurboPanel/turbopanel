/**
 * Org/server jsonb override for the metrics capability plan.
 *
 * Lives next to organization-options so features never import the daemon
 * metrics surface. The ingest planner in `daemon/metrics/capability-plan.ts`
 * re-exports these names. Slot ceiling matches topology-types `MAX_NIC_SLOTS`
 * (phase 4 will share that constant via contracts/).
 */

/** Partial override layer — org-wide (`organization.options`) or per-server (`server.options`). */
export type MetricsCapabilityPlanOverride = {
  liveMinIntervalSeconds?: number
  normalNicSlots?: number
  turboFabricEnabled?: boolean
  extraFilesystemSlots?: number
  detailedBlockDeviceSlots?: number
  gpuSlots?: number
  gpuInterconnectEnabled?: boolean
  physicalHardwareSignalSlots?: number
  managedIngressEnabled?: boolean
  databaseProxyMetricsEnabled?: boolean
  managedDockerEnabled?: boolean
  hardwareHealthEventsEnabled?: boolean
}

/** Keep aligned with `src/contracts/topology-types.ts` `MAX_NIC_SLOTS`. */
const MAX_NIC_SLOTS = 11

const POSITIVE_INT_FIELDS = ['liveMinIntervalSeconds'] as const

const NON_NEGATIVE_INT_FIELDS = [
  'normalNicSlots',
  'extraFilesystemSlots',
  'detailedBlockDeviceSlots',
  'gpuSlots',
  'physicalHardwareSignalSlots',
] as const

const BOOLEAN_FIELDS = [
  'turboFabricEnabled',
  'gpuInterconnectEnabled',
  'managedIngressEnabled',
  'databaseProxyMetricsEnabled',
  'managedDockerEnabled',
  'hardwareHealthEventsEnabled',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Parse a `metricsCapabilityPlan` override (org or server layer) from stored
 * jsonb. Every field is validated independently — unknown keys, wrong types,
 * non-integer numbers, and out-of-range numbers are all silently omitted
 * rather than rejecting the whole object, matching the
 * `parseOrganizationOptions` idiom.
 */
export function parseMetricsCapabilityPlanOverride(
  value: unknown,
): MetricsCapabilityPlanOverride {
  if (!isRecord(value)) return {}
  const override: MetricsCapabilityPlanOverride = {}
  for (const key of POSITIVE_INT_FIELDS) {
    if (isPositiveInteger(value[key])) override[key] = value[key]
  }
  for (const key of NON_NEGATIVE_INT_FIELDS) {
    if (isNonNegativeInteger(value[key])) override[key] = value[key]
  }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof value[key] === 'boolean') override[key] = value[key]
  }
  // The slot-mapping layer, the daemon, and the UI all stop at MAX_NIC_SLOTS
  // — an override above it would promise slots nothing can fill.
  if (override.normalNicSlots !== undefined && override.normalNicSlots > MAX_NIC_SLOTS) {
    override.normalNicSlots = MAX_NIC_SLOTS
  }
  return override
}
