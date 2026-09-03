import { assertEquals, assertStringIncludes } from '@std/assert'
import {
  HOST_METRIC_KEYS,
  METRIC_PARTS,
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
  collectionMode: true,
  runtimeMode: true,
  hardwareProfileGeneration: true,
  trafficSources: true,
} as const satisfies Record<keyof HostMetricsDimensions, true>

type FrameSchema = {
  required: string[]
  properties: {
    version: { const: number }
    parts: { items: { enum: string[] } }
    metrics: { required?: string[]; properties: Record<string, unknown> }
    dimensions: {
      required: string[]
      properties: Record<
        string,
        {
          const?: number
          enum?: string[]
          required?: string[]
          properties?: Record<string, unknown>
        }
      >
    }
  }
}

const frame = metricsSchemas.DaemonHostMetricsFrame as unknown as FrameSchema

test('DaemonHostMetricsFrame documents the v3 wire version', () => {
  assertEquals(METRICS_SCHEMA_VERSION, 3)
  assertEquals(frame.properties.version.const, METRICS_SCHEMA_VERSION)
  assertEquals(
    frame.properties.dimensions.properties.schemaVersion!.const,
    METRICS_SCHEMA_VERSION,
  )
})

test('DaemonHostMetricsFrame requires `parts` and documents every declarable part', () => {
  assertEquals(frame.required.includes('parts'), true)
  assertEquals(
    [...frame.properties.parts.items.enum].sort(),
    [...METRIC_PARTS].sort(),
  )
})

test('DaemonHostMetricsFrame documents every v3 metric key as optional (part-gated)', () => {
  // v3 `metrics` only carries keys whose part was declared in `parts` — no
  // key is unconditionally required at the wire-frame level.
  assertEquals(frame.properties.metrics.required, undefined)
  assertEquals(
    Object.keys(frame.properties.metrics.properties),
    [...HOST_METRIC_KEYS],
  )
})

test('DaemonHostMetricsFrame dimensions match the v3 contract', () => {
  assertEquals(frame.properties.dimensions.required, [
    'schemaVersion',
    'collectionMode',
    'hardwareProfileGeneration',
    'trafficSources',
  ])
  assertEquals(
    frame.properties.dimensions.properties.collectionMode!.enum,
    ['baseline', 'live'],
  )
  assertEquals(
    frame.properties.dimensions.properties.trafficSources!.required,
    ['caddy', 'proxysql'],
  )
  // Documented properties cover exactly the contract's dimension fields,
  // optional `runtimeMode` included.
  assertEquals(
    Object.keys(frame.properties.dimensions.properties).sort(),
    Object.keys(DIMENSION_KEYS).sort(),
  )
})

test('metrics path describes the v3 ingest frame', () => {
  const path = metricsPaths['/api/daemon/v1/metrics'] as {
    post: { description: string }
  }
  assertStringIncludes(path.post.description, 'v3 host-metrics frame')
})
