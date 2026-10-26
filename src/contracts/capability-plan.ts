/**
 * Metrics capability plan (v5) — backend-neutral model of the slot counts and
 * feature toggles a server has. Deliberately carries no pricing-tier names or
 * literals: this module never knows what plan/SKU produced them. Only the
 * feature toggles affect what is stored (see `daemon/metrics/ingest-preparation.ts`);
 * the slot counts do not cap anything that is stored. Org-wide defaults live in
 * `organization.options.metricsCapabilityPlan` (`../../lib/organization-options.ts`),
 * an optional per-server override lives in `server.options.metricsCapabilityPlan`
 * (read the same way `server-metadata.ts` reads `cpuTdpWattsOverride`), and
 * {@link resolveMetricsCapabilityPlan} layers (optional) tier-derived base
 * or platform default → org → server, mirroring
 * `resolveEffectiveCpuThermalLimits`. A hosted license with a `tier` row
 * supplies the base via {@link metricsCapabilityPlanFromTierEntitlements};
 * self-hosted and unlicensed seats keep the platform default.
 *
 * Ingest call site: `POST /api/daemon/v1/metrics` (`api-routes.ts`) resolves
 * the effective plan for the reporting server via
 * `resolveEffectiveMetricsCapabilityPlan` (`server-metadata.ts`). Both
 * editions then apply the same `prepareSampleForStorage` with the plan's
 * toggles; neither cuts devices to the slot counts.
 */

import { MAX_NIC_SLOTS } from './topology-types.ts'
import {
  type MetricsCapabilityPlanOverride,
  parseMetricsCapabilityPlanOverride,
} from '../features/organizations/metrics-capability-override.ts'

export type { MetricsCapabilityPlanOverride }
export { parseMetricsCapabilityPlanOverride }

/**
 * Steady collection cadence, seconds. Matches the daemon's `METRICS_INTERVAL_MS`.
 */
export const METRICS_BASELINE_INTERVAL_SECONDS = 60

/** Live cadence granted to a lease holder, in seconds. */
export const METRICS_LIVE_INTERVAL_SECONDS = 10

/**
 * Phase-jitter bound, seconds. Matches the daemon's `METRICS_JITTER_MAX_MS`.
 * Jitter does not change cadence; this is the slack a legitimate baseline
 * reading can sit below 60 s after a delayed tick.
 */
export const METRICS_BASELINE_JITTER_MAX_SECONDS = 5

/**
 * Primed first-delta sample delay, seconds. Matches the daemon's
 * `METRICS_PRIME_MS`. A 2 s (+ jitter) interval is a real baseline reading
 * and must still persist; it is not a 10 s live sample.
 */
export const METRICS_PRIME_INTERVAL_SECONDS = 2

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

export type MetricsCapabilityPlan = {
  /** Fastest cadence a "live" on-demand session may request, seconds. */
  liveMinIntervalSeconds: number
  /** Normal-NIC slots a server watches (`SlotMapping.normalNicSlots`); never above `MAX_NIC_SLOTS`. Does not cap what is stored. */
  normalNicSlots: number
  /** Whether TurboFabric mesh interfaces may report beyond the normal NIC slots. */
  turboFabricEnabled: boolean
  /** Additional `filesystems` entries allowed beyond root-filesystem host metrics. */
  extraFilesystemSlots: number
  /** `blockDevices` entries allowed (per-disk service devices; 0 = none). */
  detailedBlockDeviceSlots: number
  /** `gpus` entries allowed. */
  gpuSlots: number
  /** Whether GPU interconnect (NVLink/etc) signals may be reported. */
  gpuInterconnectEnabled: boolean
  /** `hardwareSignals` entries allowed (fans/voltages/PSU/etc). */
  physicalHardwareSignalSlots: number
  /** Whether `ingressSources` may be reported. */
  managedIngressEnabled: boolean
  /** Whether `databaseProxies` may be reported. */
  databaseProxyMetricsEnabled: boolean
  /**
   * Whether `dockerUsage` — Docker's own `GET /system/df` breakdown — may be
   * reported. Docker metrics are on every plan since v12: tier entitlements
   * always grant it; only an explicit org/server override can turn it off.
   * `storage` has no flag of its own: host-wide storage accounting is granted
   * at every tier, the same way `diagnostics` needed no flag once v6 merged it.
   */
  managedDockerEnabled: boolean
  /** Whether hardware-health `events` may be reported. */
  hardwareHealthEventsEnabled: boolean
}

/** Field order used for canonical serialization ({@link computeMetricsCapabilityPlanHash}). */
const METRICS_CAPABILITY_PLAN_FIELD_ORDER = [
  'liveMinIntervalSeconds',
  'normalNicSlots',
  'turboFabricEnabled',
  'extraFilesystemSlots',
  'detailedBlockDeviceSlots',
  'gpuSlots',
  'gpuInterconnectEnabled',
  'physicalHardwareSignalSlots',
  'managedIngressEnabled',
  'databaseProxyMetricsEnabled',
  'managedDockerEnabled',
  'hardwareHealthEventsEnabled',
] as const satisfies readonly (keyof MetricsCapabilityPlan)[]

/**
 * Per-server machine classification driving {@link platformDefaultMetricsCapabilityPlan}.
 * Not derived from any stored field yet — the caller (later phase: ingest,
 * once server topology/hardware detection is wired) is responsible for
 * classifying the reporting server. The declared `server.machine_class`
 * column is authoritative; {@link resolveServerMachineClass} holds the only
 * fallback (topology inference), and it applies solely while that column is
 * NULL — never as a silent default that would recreate the "every server
 * gets the same plan" bug this type exists to fix.
 */
export type ServerMachineClass = 'physical' | 'virtual'

/** Who set `server.machine_class`: ingest from the topology, or an operator. */
export const SERVER_MACHINE_CLASS_SOURCES = ['detected', 'operator'] as const
export type ServerMachineClassSource = (typeof SERVER_MACHINE_CLASS_SOURCES)[number]

export function isServerMachineClass(value: unknown): value is ServerMachineClass {
  return value === 'physical' || value === 'virtual'
}

/** Signal ids the daemon derives from a GPU entity (`signal:gpu:<gpuId>:<kind>`). */
const GPU_SIGNAL_ID_PREFIX = 'signal:gpu:'

/** True for a signal that exists only because a GPU does (never host-level hardware). */
export function isGpuDerivedSignalId(signalId: unknown): boolean {
  return typeof signalId === 'string' && signalId.startsWith(GPU_SIGNAL_ID_PREFIX)
}

/**
 * How many of `signals` prove host-level sensors. GPU-derived signals are
 * excluded: a virtual display adapter or passthrough GPU reports them on a VM
 * too (the io/megaclite/themisto bug), so they never make a machine physical.
 * Accepts topology snapshot entries (`{ signalId }`) and sample signals alike.
 */
export function countHostLevelSignals(signals: readonly unknown[]): number {
  let count = 0
  for (const signal of signals) {
    const id =
      typeof signal === 'object' && signal !== null
        ? (signal as Record<string, unknown>).signalId
        : undefined
    if (!isGpuDerivedSignalId(id)) count += 1
  }
  return count
}

/**
 * Infer a machine class from whichever topology snapshot is on hand (the
 * daemon's `topology-report.snapshot`, stored verbatim by
 * `recordTopologyGeneration`). A v6 daemon states its own verdict in
 * `snapshot.machineClass` (DMI-based, `physical-classifier.ts`), and that
 * wins: a bare-metal host with nothing discoverable is still physical.
 * Without it, the sensor proxy: a physical host is the only kind that ever
 * discovers host-level sensors, so a non-empty `hardwareSignals` array is
 * proof of `'physical'` (GPU-derived signals excluded, see
 * {@link countHostLevelSignals}); an empty one is only absence of proof and resolves
 * `'virtual'`. A snapshot that lacks the array entirely (none recorded, or a
 * minimal test snapshot) falls through to `sampleSignalCount` — the raw,
 * sample's own signal count at ingest, `0` on the read side
 * where there is no sample.
 */
export function inferServerMachineClass(
  topologySnapshot: unknown,
  sampleSignalCount = 0
): ServerMachineClass {
  if (
    typeof topologySnapshot === 'object' &&
    topologySnapshot !== null &&
    !Array.isArray(topologySnapshot)
  ) {
    const declaredByDaemon = (topologySnapshot as Record<string, unknown>).machineClass
    if (isServerMachineClass(declaredByDaemon)) return declaredByDaemon
    const signals = (topologySnapshot as Record<string, unknown>).hardwareSignals
    if (Array.isArray(signals)) {
      return countHostLevelSignals(signals) > 0 ? 'physical' : 'virtual'
    }
  }
  return sampleSignalCount > 0 ? 'physical' : 'virtual'
}

/**
 * The one machine-class resolution both ingest and the read-side routes use,
 * so the plan applied at ingest and the limits the UI reports never
 * disagree. The declared `server.machine_class` column wins outright — an
 * operator can pin a VM that exposes a bogus thermal zone to `'virtual'`, or
 * a physical box whose sensors are not exposed to `'physical'`. Only while
 * the column is NULL does {@link inferServerMachineClass} run.
 */
export function resolveServerMachineClass(
  declared: unknown,
  topologySnapshot: unknown,
  sampleSignalCount = 0
): ServerMachineClass {
  if (isServerMachineClass(declared)) return declared
  return inferServerMachineClass(topologySnapshot, sampleSignalCount)
}

/**
 * Which deployment resolves the plan: the hosted platform (Cloudflare
 * Workers — every server gets the platform default unless a license tier
 * supplies entitlements) or a self-hosted instance (Deno), which is not
 * metered and gets the self-hosted ceiling instead. Derived from the runtime
 * by {@link metricsDeploymentKindForRuntime}; never inferred from globals, so
 * a test running under Deno still exercises hosted behavior unless it asks
 * for the other.
 */
export type MetricsDeploymentKind = 'hosted' | 'self-hosted'

export function metricsDeploymentKindForRuntime(
  runtime: 'workers' | 'deno'
): MetricsDeploymentKind {
  return runtime === 'workers' ? 'hosted' : 'self-hosted'
}

/**
 * The most entries of one device kind a sample may carry: the sample
 * validator's cap (64 per kind). A plan names no fewer: the number of drives,
 * network cards, GPUs, extra filesystems and sensors a server may report is
 * set by the machine and these shared limits, never by a plan or an override.
 */
export const METRICS_DEVICE_SLOT_CEILING = 64

/**
 * Every plan the control plane resolves, pushes to a daemon and shows has its
 * device slot counts at the ceilings, so neither the control plane nor a
 * daemon holding the plan cuts devices. Tier entitlements and org or server
 * overrides of a slot count are ignored for the same reason; their switches
 * (web traffic, database proxy, Docker usage, hardware health events, mesh
 * interfaces) are not.
 */
const DEVICE_SLOT_CEILINGS = {
  normalNicSlots: MAX_NIC_SLOTS,
  extraFilesystemSlots: METRICS_DEVICE_SLOT_CEILING,
  detailedBlockDeviceSlots: METRICS_DEVICE_SLOT_CEILING,
  gpuSlots: METRICS_DEVICE_SLOT_CEILING,
  physicalHardwareSignalSlots: METRICS_DEVICE_SLOT_CEILING,
} as const satisfies Partial<MetricsCapabilityPlan>

/**
 * Self-hosted NIC-slot default — the ceiling itself (`MAX_NIC_SLOTS`): a
 * self-hosted instance is not metered, so an operator may monitor as many
 * physical uplinks as the topology offers, up to the hard cap.
 */
export const SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS = MAX_NIC_SLOTS

/**
 * Platform fallback applied when neither org nor server override a field —
 * the **hosted** baseline. `normalNicSlots` is the hosted default (2 — one
 * gateway NIC plus one extra; more will need a higher tier later) and
 * `physicalHardwareSignalSlots` reflects the `"physical"` baseline — use
 * {@link platformDefaultMetricsCapabilityPlan} (or
 * {@link resolveMetricsCapabilityPlan}) to get the per-machine-class,
 * per-deployment default, since a virtual machine has no host-level fan/
 * voltage/PSU/etc. sensors to report and a self-hosted instance is not
 * NIC-metered.
 */
export const PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN: MetricsCapabilityPlan = {
  liveMinIntervalSeconds: 10,
  normalNicSlots: 2,
  turboFabricEnabled: true,
  extraFilesystemSlots: 0,
  detailedBlockDeviceSlots: 3,
  gpuSlots: 1,
  gpuInterconnectEnabled: false,
  physicalHardwareSignalSlots: 19,
  managedIngressEnabled: true,
  databaseProxyMetricsEnabled: true,
  // On for every plan, tiered or not (v12).
  managedDockerEnabled: true,
  hardwareHealthEventsEnabled: true,
}

/**
 * Extra (non-root) filesystems the entry tier stores: one, because a lone
 * extra filesystem folds into a host row at no row cost. Callers pass
 * {@link MetricsCapabilityTierEntitlements.isEntryTier} rather than a label
 * so this module never names a priced SKU.
 */
const ENTRY_TIER_EXTRA_FILESYSTEM_SLOTS = 1

/**
 * Already-resolved numeric entitlements from a `tier` row. The caller
 * computes `isEntryTier` from `rank` (entry = rank 1) so this module stays
 * free of priced-offering labels.
 */
export type MetricsCapabilityTierEntitlements = {
  nicSlots: number
  driveSlots: number
  gpuSlots: number
  filesystemSlots: number
  isEntryTier: boolean
}

/**
 * Map a tier's raw entitlement columns onto {@link MetricsCapabilityPlan}.
 * Unspecified fields (cadence, interconnect, ingress, proxy, health events)
 * keep the platform default. `physicalHardwareSignalSlots` is still zeroed
 * for virtual machines and otherwise the platform default on every tier (the
 * old entry-tier 11-signal cap is gone). The entry tier stores one extra
 * filesystem. `managedDockerEnabled` is on for every tier.
 */
export function metricsCapabilityPlanFromTierEntitlements(
  entitlements: MetricsCapabilityTierEntitlements,
  machineClass: ServerMachineClass,
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlan {
  const base = platformDefaultMetricsCapabilityPlan(machineClass, deployment)
  const normalNicSlots = Math.min(Math.max(entitlements.nicSlots, 0), MAX_NIC_SLOTS)
  const extraFilesystemSlots = entitlements.isEntryTier
    ? Math.min(ENTRY_TIER_EXTRA_FILESYSTEM_SLOTS, entitlements.filesystemSlots)
    : entitlements.filesystemSlots
  return {
    ...base,
    normalNicSlots,
    extraFilesystemSlots,
    detailedBlockDeviceSlots: entitlements.driveSlots,
    gpuSlots: entitlements.gpuSlots,
    managedDockerEnabled: true,
  }
}

/**
 * Resolve a plan from already-mapped tier entitlements (no org/server
 * override layer). Prefer {@link resolveMetricsCapabilityPlan} at call sites
 * that also have jsonb overrides.
 */
export function resolveTierMetricsCapabilityPlan(
  entitlements: MetricsCapabilityTierEntitlements,
  machineClass: ServerMachineClass,
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlan {
  return metricsCapabilityPlanFromTierEntitlements(entitlements, machineClass, deployment)
}

/**
 * Platform default plan for a given {@link ServerMachineClass} and
 * {@link MetricsDeploymentKind} — every field matches
 * {@link PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN} except
 * `physicalHardwareSignalSlots` (`19` only for `"physical"`, `0` for
 * `"virtual"`) and `normalNicSlots` (`SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS`
 * for a self-hosted instance).
 */
export function platformDefaultMetricsCapabilityPlan(
  machineClass: ServerMachineClass,
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlan {
  return {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    normalNicSlots:
      deployment === 'self-hosted'
        ? SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS
        : PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.normalNicSlots,
    physicalHardwareSignalSlots:
      machineClass === 'physical'
        ? PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.physicalHardwareSignalSlots
        : 0,
  }
}

/**
 * Parse a `metricsCapabilityPlan` override nested under `server.options`.
 * Same parse discipline as {@link parseMetricsCapabilityPlanOverride} — kept
 * as a distinct export so call sites read as "server layer" vs. "org layer"
 * without relying on a shared name to convey that.
 */
export function parseServerMetricsCapabilityPlanOverride(
  value: unknown
): MetricsCapabilityPlanOverride {
  return parseMetricsCapabilityPlanOverride(value)
}

/**
 * Strict parse of a full persisted/pushed {@link MetricsCapabilityPlan}.
 * Every field must be present and valid — a partial override is not a plan.
 */
export function parseMetricsCapabilityPlan(value: unknown): MetricsCapabilityPlan | undefined {
  const override = parseMetricsCapabilityPlanOverride(value)
  for (const key of METRICS_CAPABILITY_PLAN_FIELD_ORDER) {
    if (override[key] === undefined) return undefined
  }
  return override as MetricsCapabilityPlan
}

/**
 * Resolve the effective plan: (optional) tier-derived base or per-machine-class
 * platform default → org override → server override, field by field (a later
 * layer only wins for fields it actually sets —
 * {@link parseMetricsCapabilityPlanOverride} never emits a key it couldn't
 * validate, so partial layers compose safely).
 *
 * When `tierEntitlements` is present it replaces
 * {@link platformDefaultMetricsCapabilityPlan} as the base; org/server
 * overrides still win on top. Absent entitlements (self-hosted, or a license
 * without a tier) preserve the historical platform-default path.
 *
 * `machineClass` is required (not defaulted) so a virtual server can never
 * silently inherit the physical `physicalHardwareSignalSlots` baseline — see
 * {@link platformDefaultMetricsCapabilityPlan}. An explicit org/server
 * override for that field still wins over the machine-class default, same as
 * any other field.
 */
export function resolveMetricsCapabilityPlan(
  machineClass: ServerMachineClass,
  orgOverride: MetricsCapabilityPlanOverride | undefined,
  serverOverride: MetricsCapabilityPlanOverride | undefined,
  deployment: MetricsDeploymentKind,
  tierEntitlements?: MetricsCapabilityTierEntitlements
): MetricsCapabilityPlan {
  const base = tierEntitlements
    ? metricsCapabilityPlanFromTierEntitlements(tierEntitlements, machineClass, deployment)
    : platformDefaultMetricsCapabilityPlan(machineClass, deployment)
  return {
    ...base,
    ...orgOverride,
    ...serverOverride,
    ...DEVICE_SLOT_CEILINGS,
  }
}

/**
 * Deterministic SHA-256 hex digest of a resolved plan — used to detect
 * whether a server's effective plan actually changed between resolutions
 * (see `capability-plan-records.ts`). Domain-separated so this can never be
 * confused with a hash of the same field values computed elsewhere. Uses Web
 * Crypto (`crypto.subtle`) only — safe on both Workers and Deno, no Node-only
 * APIs.
 */
export async function computeMetricsCapabilityPlanHash(
  plan: MetricsCapabilityPlan
): Promise<string> {
  const canonical = METRICS_CAPABILITY_PLAN_FIELD_ORDER.map((key) => [key, plan[key]] as const)
  const material = new TextEncoder().encode(
    `turbopanel:metrics-capability-plan:${JSON.stringify(canonical)}`
  )
  const digest = await crypto.subtle.digest('SHA-256', material)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Conservative fallback plan resolution — platform defaults only, always
 * `"virtual"` machine class (no host-level hardware-signal slots granted).
 * Ingest (`api-routes.ts`) uses `resolveEffectiveMetricsCapabilityPlan`
 * (`server-metadata.ts`) for the real, persisted-state resolution and falls
 * back to this only when no DB is available for the request or the real
 * resolution itself fails — never as the default path.
 */
export function resolveDefaultMetricsCapabilityPlan(
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlan {
  return resolveMetricsCapabilityPlan('virtual', undefined, undefined, deployment)
}

/** CPU architectures a server can report, as the daemon spells them (mirrored by `server_os_architecture_check`). */
export const SERVER_OS_ARCHITECTURES = ['x86_64', 'aarch64'] as const
export type ServerOsArchitecture = (typeof SERVER_OS_ARCHITECTURES)[number]

/**
 * Map a daemon-reported architecture onto the stored spelling. Older daemons
 * and other tools say `amd64`, `arm64` or `x64`; anything that is not a 64-bit
 * x86 or Arm CPU (for example `armv7l`) returns null and is not stored.
 */
export function normalizeServerOsArchitecture(raw: unknown): ServerOsArchitecture | null {
  if (typeof raw !== 'string') return null
  switch (raw.trim().toLowerCase()) {
    case 'x86_64':
    case 'x86-64':
    case 'amd64':
    case 'x64':
      return 'x86_64'
    case 'aarch64':
    case 'arm64':
    case 'armv8':
    case 'armv8l':
    case 'armv8a':
      return 'aarch64'
    default:
      return null
  }
}
