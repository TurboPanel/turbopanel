import { assertEquals, assertStringIncludes } from '@std/assert'
import {
  HOST_METRIC_KEYS,
  METRICS_SCHEMA_VERSION,
  type HostMetricsDimensions,
} from '../metrics/contract.ts'
import { metricsPaths, metricsSchemas } from './metrics.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * Every wire dimension the daemon can send. `satisfies` makes this fail to
 * compile when `HostMetricsDimensions` gains or loses a field, so the OpenAPI
 * document cannot drift from the contract silently.
 */
const DIMENSION_KEYS = {
  schemaVersion: true,
  daemonVersion: true,
  operatingSystem: true,
  architecture: true,
  kernelRelease: true,
  collectionMode: true,
  runtimeMode: true,
  cpuTemperatureSensor: true,
  gpuTemperatureSensor: true,
  cpuPowerSensor: true,
  gpuPowerSensor: true,
  uplinkInterfaces: true,
  fabricInterfaces: true,
} as const satisfies Record<keyof HostMetricsDimensions, true>

type FrameSchema = {
  required: string[]
  properties: {
    version: { const: number }
    metrics: { required: string[]; properties: Record<string, unknown> }
    dimensions: {
      required: string[]
      properties: Record<string, { const?: number; enum?: string[] }>
    }
  }
}

const frame = metricsSchemas.DaemonHostMetricsFrame as unknown as FrameSchema

test('DaemonHostMetricsFrame documents the v2 wire version', () => {
  assertEquals(METRICS_SCHEMA_VERSION, 2)
  assertEquals(frame.properties.version.const, METRICS_SCHEMA_VERSION)
  assertEquals(
    frame.properties.dimensions.properties.schemaVersion!.const,
    METRICS_SCHEMA_VERSION,
  )
})

test('DaemonHostMetricsFrame requires every v2 metric key', () => {
  assertEquals(frame.properties.metrics.required, [...HOST_METRIC_KEYS])
  assertEquals(
    Object.keys(frame.properties.metrics.properties),
    [...HOST_METRIC_KEYS],
  )
})

test('DaemonHostMetricsFrame dimensions match the v2 contract', () => {
  // Required set mirrors the non-optional fields of HostMetricsDimensions —
  // collectionMode became mandatory in v2.
  assertEquals(frame.properties.dimensions.required, [
    'schemaVersion',
    'daemonVersion',
    'operatingSystem',
    'architecture',
    'kernelRelease',
    'collectionMode',
  ])
  assertEquals(
    frame.properties.dimensions.properties.collectionMode!.enum,
    ['baseline', 'live'],
  )
  // Documented properties cover exactly the contract's dimension fields,
  // optional sensor-identity and interface-selection fields included.
  assertEquals(
    Object.keys(frame.properties.dimensions.properties).sort(),
    Object.keys(DIMENSION_KEYS).sort(),
  )
})

test('metrics path describes the v2 ingest frame', () => {
  const path = metricsPaths['/api/daemon/v1/metrics'] as {
    post: { description: string }
  }
  assertStringIncludes(path.post.description, 'v2 host-metrics frame')
})
