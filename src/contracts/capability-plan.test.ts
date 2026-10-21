import { assertEquals, assertNotEquals } from '@std/assert'
import {
  computeMetricsCapabilityPlanHash,
  countHostLevelSignals,
  inferServerMachineClass,
  isServerMachineClass,
  METRICS_DEVICE_SLOT_CEILING,
  metricsCapabilityPlanFromTierEntitlements,
  type MetricsCapabilityTierEntitlements,
  metricsDeploymentKindForRuntime,
  parseMetricsCapabilityPlanOverride,
  PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
  platformDefaultMetricsCapabilityPlan,
  resolveMetricsCapabilityPlan,
  resolveServerMachineClass,
  resolveTierMetricsCapabilityPlan,
  SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS,
} from './capability-plan.ts'
import { MAX_NIC_SLOTS } from './topology-types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const CEILINGS = {
  normalNicSlots: MAX_NIC_SLOTS,
  extraFilesystemSlots: METRICS_DEVICE_SLOT_CEILING,
  detailedBlockDeviceSlots: METRICS_DEVICE_SLOT_CEILING,
  gpuSlots: METRICS_DEVICE_SLOT_CEILING,
  physicalHardwareSignalSlots: METRICS_DEVICE_SLOT_CEILING,
}

test('resolveMetricsCapabilityPlan with no overrides returns the platform default with the device slots at the ceilings', () => {
  const resolved = resolveMetricsCapabilityPlan('physical', undefined, undefined, 'hosted')
  assertEquals(resolved, { ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN, ...CEILINGS })
})

test('resolveMetricsCapabilityPlan: the ceiling is the sample validator cap of 64 entries per kind', () => {
  assertEquals(METRICS_DEVICE_SLOT_CEILING, 64)
})

test('resolveMetricsCapabilityPlan: org override wins over platform default for switches', () => {
  const resolved = resolveMetricsCapabilityPlan(
    'physical',
    { managedIngressEnabled: false },
    undefined,
    'hosted'
  )
  assertEquals(resolved.managedIngressEnabled, false)
  assertEquals(resolved.databaseProxyMetricsEnabled, true)
})

test('resolveMetricsCapabilityPlan: server override wins over org override and only touches fields it sets', () => {
  const resolved = resolveMetricsCapabilityPlan(
    'physical',
    { hardwareHealthEventsEnabled: false, managedIngressEnabled: false },
    { hardwareHealthEventsEnabled: true },
    'hosted'
  )
  assertEquals(resolved.hardwareHealthEventsEnabled, true)
  assertEquals(resolved.managedIngressEnabled, false)
})

test('resolveMetricsCapabilityPlan: no override or machine class lowers a device slot count', () => {
  for (const machineClass of ['virtual', 'physical'] as const) {
    for (const deployment of ['hosted', 'self-hosted'] as const) {
      const resolved = resolveMetricsCapabilityPlan(
        machineClass,
        { gpuSlots: 1, normalNicSlots: 1 },
        { physicalHardwareSignalSlots: 0, detailedBlockDeviceSlots: 1, extraFilesystemSlots: 0 },
        deployment
      )
      assertEquals(
        {
          normalNicSlots: resolved.normalNicSlots,
          extraFilesystemSlots: resolved.extraFilesystemSlots,
          detailedBlockDeviceSlots: resolved.detailedBlockDeviceSlots,
          gpuSlots: resolved.gpuSlots,
          physicalHardwareSignalSlots: resolved.physicalHardwareSignalSlots,
        },
        CEILINGS
      )
    }
  }
})

test('platformDefaultMetricsCapabilityPlan: a virtual machine has no host sensor slots by default, a physical one 19', () => {
  assertEquals(
    platformDefaultMetricsCapabilityPlan('virtual', 'hosted').physicalHardwareSignalSlots,
    0
  )
  assertEquals(
    platformDefaultMetricsCapabilityPlan('physical', 'hosted').physicalHardwareSignalSlots,
    19
  )
})

test('platformDefaultMetricsCapabilityPlan matches PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN for physical machines', () => {
  assertEquals(
    platformDefaultMetricsCapabilityPlan('physical', 'hosted'),
    PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN
  )
})

test('platformDefaultMetricsCapabilityPlan: hosted servers get 2 NIC slots, self-hosted the MAX_NIC_SLOTS ceiling, nothing else differs', () => {
  const hosted = platformDefaultMetricsCapabilityPlan('virtual', 'hosted')
  const selfHosted = platformDefaultMetricsCapabilityPlan('virtual', 'self-hosted')
  assertEquals(hosted.normalNicSlots, 2)
  assertEquals(selfHosted.normalNicSlots, SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS)
  assertEquals(SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS, MAX_NIC_SLOTS)
  assertEquals(
    { ...hosted, normalNicSlots: 0 },
    {
      ...selfHosted,
      normalNicSlots: 0,
    }
  )
  assertEquals(metricsDeploymentKindForRuntime('workers'), 'hosted')
  assertEquals(metricsDeploymentKindForRuntime('deno'), 'self-hosted')
})

const ENTRY_TIER_ENTITLEMENTS: MetricsCapabilityTierEntitlements = {
  nicSlots: 2,
  driveSlots: 2,
  gpuSlots: 1,
  filesystemSlots: 4,
  isEntryTier: true,
}

const STANDARD_TIER_ENTITLEMENTS: MetricsCapabilityTierEntitlements = {
  nicSlots: 5,
  driveSlots: 4,
  gpuSlots: 2,
  filesystemSlots: 3,
  isEntryTier: false,
}

test('metricsCapabilityPlanFromTierEntitlements overrides the platform default slot counts', () => {
  const plan = metricsCapabilityPlanFromTierEntitlements(
    STANDARD_TIER_ENTITLEMENTS,
    'physical',
    'hosted'
  )
  assertEquals(plan.normalNicSlots, 5)
  assertEquals(plan.detailedBlockDeviceSlots, 4)
  assertEquals(plan.gpuSlots, 2)
  assertEquals(plan.extraFilesystemSlots, 3)
  assertEquals(plan.managedDockerEnabled, true)
  assertEquals(
    plan.physicalHardwareSignalSlots,
    PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.physicalHardwareSignalSlots
  )
  assertEquals(
    resolveTierMetricsCapabilityPlan(STANDARD_TIER_ENTITLEMENTS, 'physical', 'hosted'),
    plan
  )
})

test('metricsCapabilityPlanFromTierEntitlements: entry-tier carve-outs apply only at the entry tier', () => {
  const entry = metricsCapabilityPlanFromTierEntitlements(
    ENTRY_TIER_ENTITLEMENTS,
    'physical',
    'hosted'
  )
  assertEquals(entry.extraFilesystemSlots, 1)
  assertEquals(entry.physicalHardwareSignalSlots, 19)
  assertEquals(entry.managedDockerEnabled, true)

  const standard = metricsCapabilityPlanFromTierEntitlements(
    STANDARD_TIER_ENTITLEMENTS,
    'physical',
    'hosted'
  )
  assertEquals(standard.extraFilesystemSlots, 3)
  assertEquals(standard.physicalHardwareSignalSlots, 19)
  assertEquals(standard.managedDockerEnabled, true)
})

test('metricsCapabilityPlanFromTierEntitlements: virtual machines still get zero hardware-signal slots on the entry tier', () => {
  const plan = metricsCapabilityPlanFromTierEntitlements(
    ENTRY_TIER_ENTITLEMENTS,
    'virtual',
    'hosted'
  )
  assertEquals(plan.physicalHardwareSignalSlots, 0)
  assertEquals(plan.managedDockerEnabled, true)
})

test('inferServerMachineClass: GPU-derived signals never prove a machine physical', () => {
  const gpuOnly = {
    hardwareSignals: [
      { signalId: 'signal:gpu:0x1234-bochs:temperature' },
      { signalId: 'signal:gpu:0x1234-bochs:power' },
    ],
  }
  assertEquals(inferServerMachineClass(gpuOnly), 'virtual')
  assertEquals(
    inferServerMachineClass({
      hardwareSignals: [...gpuOnly.hardwareSignals, { signalId: 'signal:coretemp:Package id 0' }],
    }),
    'physical'
  )
  assertEquals(
    countHostLevelSignals([
      { signalId: 'signal:gpu:a:power' },
      { signalId: 'signal:block:sda:temperature' },
    ]),
    1
  )
  assertEquals(
    inferServerMachineClass(undefined, countHostLevelSignals(gpuOnly.hardwareSignals)),
    'virtual'
  )
})

test('resolveMetricsCapabilityPlan: a tier changes no device slot count', () => {
  const resolved = resolveMetricsCapabilityPlan(
    'physical',
    undefined,
    undefined,
    'hosted',
    ENTRY_TIER_ENTITLEMENTS
  )
  assertEquals(resolved.normalNicSlots, MAX_NIC_SLOTS)
  assertEquals(resolved.gpuSlots, METRICS_DEVICE_SLOT_CEILING)
  assertEquals(
    resolved,
    resolveMetricsCapabilityPlan(
      'physical',
      undefined,
      undefined,
      'hosted',
      STANDARD_TIER_ENTITLEMENTS
    )
  )
})

test('computeMetricsCapabilityPlanHash changes when tier entitlements change the resolved plan', async () => {
  const entryHash = await computeMetricsCapabilityPlanHash(
    metricsCapabilityPlanFromTierEntitlements(ENTRY_TIER_ENTITLEMENTS, 'physical', 'hosted')
  )
  const standardHash = await computeMetricsCapabilityPlanHash(
    metricsCapabilityPlanFromTierEntitlements(STANDARD_TIER_ENTITLEMENTS, 'physical', 'hosted')
  )
  assertNotEquals(entryHash, standardHash)
})

test('parseMetricsCapabilityPlanOverride clamps normalNicSlots to MAX_NIC_SLOTS', () => {
  assertEquals(parseMetricsCapabilityPlanOverride({ normalNicSlots: 99 }), {
    normalNicSlots: MAX_NIC_SLOTS,
  })
  assertEquals(parseMetricsCapabilityPlanOverride({ normalNicSlots: 3 }), {
    normalNicSlots: 3,
  })
})

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseMetricsCapabilityPlanOverride returns empty object for non-records', () => {
  assertEquals(parseMetricsCapabilityPlanOverride(null), {})
  assertEquals(parseMetricsCapabilityPlanOverride([]), {})
  assertEquals(parseMetricsCapabilityPlanOverride('nope'), {})
})

test('parseMetricsCapabilityPlanOverride reads every field type', () => {
  const override = parseMetricsCapabilityPlanOverride({
    liveMinIntervalSeconds: 5,
    normalNicSlots: 3,
    turboFabricEnabled: false,
    extraFilesystemSlots: 2,
    detailedBlockDeviceSlots: 1,
    gpuSlots: 2,
    gpuInterconnectEnabled: true,
    physicalHardwareSignalSlots: 24,
    managedIngressEnabled: false,
    databaseProxyMetricsEnabled: false,
    hardwareHealthEventsEnabled: false,
  })
  assertEquals(override, {
    liveMinIntervalSeconds: 5,
    normalNicSlots: 3,
    turboFabricEnabled: false,
    extraFilesystemSlots: 2,
    detailedBlockDeviceSlots: 1,
    gpuSlots: 2,
    gpuInterconnectEnabled: true,
    physicalHardwareSignalSlots: 24,
    managedIngressEnabled: false,
    databaseProxyMetricsEnabled: false,
    hardwareHealthEventsEnabled: false,
  })
})

test('parseMetricsCapabilityPlanOverride rejects invalid types silently', () => {
  const override = parseMetricsCapabilityPlanOverride({
    gpuSlots: '2',
    turboFabricEnabled: 'yes',
    extraFilesystemSlots: null,
  })
  assertEquals(override, {})
})

test('parseMetricsCapabilityPlanOverride rejects negative and non-integer numbers', () => {
  assertEquals(parseMetricsCapabilityPlanOverride({ gpuSlots: -1 }).gpuSlots, undefined)
  assertEquals(parseMetricsCapabilityPlanOverride({ gpuSlots: 1.5 }).gpuSlots, undefined)
  assertEquals(
    parseMetricsCapabilityPlanOverride({ liveMinIntervalSeconds: 0 }).liveMinIntervalSeconds,
    undefined
  )
  assertEquals(
    parseMetricsCapabilityPlanOverride({ liveMinIntervalSeconds: -10 }).liveMinIntervalSeconds,
    undefined
  )
})

test('parseMetricsCapabilityPlanOverride silently omits unknown keys', () => {
  const override = parseMetricsCapabilityPlanOverride({
    gpuSlots: 2,
    pricingTier: 'enterprise',
  })
  assertEquals(override, { gpuSlots: 2 })
  assertEquals('pricingTier' in override, false)
})

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

test('computeMetricsCapabilityPlanHash is stable for an identical plan', async () => {
  const a = await computeMetricsCapabilityPlanHash(PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN)
  const b = await computeMetricsCapabilityPlanHash({
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
  })
  assertEquals(a, b)
})

test('computeMetricsCapabilityPlanHash changes when one field changes', async () => {
  const base = await computeMetricsCapabilityPlanHash(PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN)
  const changed = await computeMetricsCapabilityPlanHash({
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.gpuSlots + 1,
  })
  assertNotEquals(base, changed)
})

test('isServerMachineClass accepts only the two declared values', () => {
  assertEquals(isServerMachineClass('physical'), true)
  assertEquals(isServerMachineClass('virtual'), true)
  assertEquals(isServerMachineClass(null), false)
  assertEquals(isServerMachineClass(undefined), false)
  assertEquals(isServerMachineClass('PHYSICAL'), false)
  assertEquals(isServerMachineClass('bare-metal'), false)
})

test("inferServerMachineClass: the daemon's own verdict on the snapshot wins over the sensor proxy", () => {
  // Bare metal with nothing discoverable: v4 read this as virtual.
  assertEquals(
    inferServerMachineClass({ machineClass: 'physical', hardwareSignals: [] }),
    'physical'
  )
  // A passthrough-GPU VM that somehow carries a signal stays virtual.
  assertEquals(
    inferServerMachineClass({ machineClass: 'virtual', hardwareSignals: [{ signalId: 'cpu' }] }),
    'virtual'
  )
  // A malformed verdict is ignored and the proxy decides: the array is
  // present and empty, so absence of proof reads virtual even with a
  // sample count beside it.
  assertEquals(
    inferServerMachineClass({ machineClass: 'bare-metal', hardwareSignals: [] }, 2),
    'virtual'
  )
  assertEquals(inferServerMachineClass({ machineClass: 'bare-metal' }, 2), 'physical')
})

test('inferServerMachineClass: a non-empty hardwareSignals array is proof of physical', () => {
  assertEquals(inferServerMachineClass({ hardwareSignals: [{ signalId: 'cpu' }] }), 'physical')
  assertEquals(inferServerMachineClass({ hardwareSignals: [] }), 'virtual')
})

test('inferServerMachineClass falls through to the sample only when the snapshot lacks the array', () => {
  assertEquals(inferServerMachineClass(undefined, 2), 'physical')
  assertEquals(inferServerMachineClass(undefined, 0), 'virtual')
  assertEquals(inferServerMachineClass({}, 1), 'physical')
  assertEquals(inferServerMachineClass([], 1), 'physical')
  // A snapshot that carries the array is authoritative over the sample.
  assertEquals(inferServerMachineClass({ hardwareSignals: [] }, 5), 'virtual')
})

test('resolveServerMachineClass: the declared column beats every inference', () => {
  assertEquals(resolveServerMachineClass('virtual', { hardwareSignals: [{}] }, 3), 'virtual')
  assertEquals(resolveServerMachineClass('physical', { hardwareSignals: [] }, 0), 'physical')
})

test('resolveServerMachineClass: NULL and out-of-range declarations fall back to inference', () => {
  assertEquals(resolveServerMachineClass(null, { hardwareSignals: [{}] }), 'physical')
  assertEquals(resolveServerMachineClass(undefined, { hardwareSignals: [] }), 'virtual')
  assertEquals(resolveServerMachineClass('bare-metal', undefined, 1), 'physical')
  assertEquals(resolveServerMachineClass('', undefined, 0), 'virtual')
})
