import { assertEquals, assertExists } from '@std/assert'
import { HOST_METRIC_KEYS } from '../../daemon/metrics/contract.ts'
import type { ServerHardwareProfileUpdate } from '../../lib/db/server-metadata.ts'
import { metricsPaths, metricsSchemas } from './metrics.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type SchemaObject = {
  properties?: Record<string, unknown>
  required?: string[]
  enum?: string[]
  const?: unknown
  additionalProperties?: boolean
  $ref?: string
}

/**
 * Every field `parseHardwareProfileBody` accepts as a PUT update, mirrored
 * here so `satisfies` fails to compile when `ServerHardwareProfileUpdate`
 * gains or loses a field — the request schema below cannot drift silently.
 */
const HARDWARE_PROFILE_UPDATE_KEYS = {
  cpuTemperature: true,
  cpuPower: true,
  gpuDevice: true,
  gpuFan: true,
  disk1Temperature: true,
  disk2Temperature: true,
  ambient1Temperature: true,
  ambient2Temperature: true,
  boardTemperature: true,
  cpuFan: true,
  systemFan1: true,
  systemFan2: true,
  nic1: true,
  nic2: true,
  hostingPath: true,
  drivetempEnabled: true,
  cpuTdpWattsOverride: true,
  cpuTjMaxCelsiusOverride: true,
} as const satisfies Record<keyof ServerHardwareProfileUpdate, true>

test('metricsPaths documents the client query surface under the client API prefix', () => {
  assertEquals(
    Object.keys(metricsPaths).sort((a, b) => a.localeCompare(b)),
    [
      '/api/client/v1/servers/{id}/metrics/connection',
      '/api/client/v1/servers/{id}/metrics/hardware-profile',
      '/api/client/v1/servers/{id}/metrics/series',
      '/api/client/v1/servers/{id}/metrics/summary',
    ]
  )
})

test('metrics query routes use cookieAuth, never bearerAuth', () => {
  for (const [path, methods] of Object.entries(metricsPaths)) {
    for (const [method, op] of Object.entries(methods as Record<string, { security?: unknown }>)) {
      assertEquals(
        op.security,
        [{ cookieAuth: [] }],
        `${method.toUpperCase()} ${path} should require cookieAuth`
      )
    }
  }
})

test('HostMetricValues documents exactly the HostMetricKey allowlist', () => {
  const schema = metricsSchemas.HostMetricValues as SchemaObject
  assertEquals(Object.keys(schema.properties!).sort(), [...HOST_METRIC_KEYS].sort())
  assertEquals(schema.additionalProperties, false)
})

test('HostSeriesChartPointDerived requires every derived + headroom field', () => {
  const schema = metricsSchemas.HostSeriesChartPointDerived as SchemaObject
  assertEquals(schema.required, [
    'cpuUsagePercent',
    'memoryUsedBytes',
    'memoryUsedPercent',
    'swapUsedBytes',
    'swapUsedPercent',
    'systemStorageUsedBytes',
    'systemStorageUsedPercent',
    'hostingStorageUsedBytes',
    'hostingStorageUsedPercent',
    'dockerStorageUsedBytes',
    'dockerStorageUsedPercent',
    'httpErrorRatePercent',
    'httpAverageLatencyMs',
    'cpuThermalHeadroomPercent',
    'cpuPowerHeadroomPercent',
  ])
})

test('HostSeriesChartResponse carries the envelope + sensorsAvailable added by the /series route', () => {
  const schema = metricsSchemas.HostSeriesChartResponse as SchemaObject
  assertEquals(schema.required?.includes('cpuLimits'), true)
  assertEquals(schema.required?.includes('temperatureUnit'), true)
  assertEquals(schema.required?.includes('sensorsAvailable'), true)
  assertEquals(schema.required?.includes('generationBreaks'), true)
  // hardwareProfileGenerations is spread-guarded, never unconditionally present
  assertEquals(schema.required?.includes('hardwareProfileGenerations'), false)
  assertEquals((schema.properties!.backend as SchemaObject).enum, [
    'disabled',
    'analytics-engine',
    'duckdb',
  ])
})

test('HostSummaryChartResponse carries the envelope but not sensorsAvailable/generationBreaks', () => {
  const schema = metricsSchemas.HostSummaryChartResponse as SchemaObject
  assertEquals(schema.required?.includes('cpuLimits'), true)
  assertEquals(schema.required?.includes('temperatureUnit'), true)
  assertEquals('sensorsAvailable' in (schema.properties ?? {}), false)
  assertEquals('generationBreaks' in (schema.properties ?? {}), false)
})

test('ConnectionHistoryChartResponse carries no cpuLimits/temperatureUnit envelope', () => {
  const schema = metricsSchemas.ConnectionHistoryChartResponse as SchemaObject
  assertEquals('cpuLimits' in (schema.properties ?? {}), false)
  assertEquals('temperatureUnit' in (schema.properties ?? {}), false)
})

test('EffectiveCpuThermalLimits documents the resolution-source enum', () => {
  const schema = metricsSchemas.EffectiveCpuThermalLimits as SchemaObject
  assertEquals((schema.properties!.source as SchemaObject).enum, [
    'override',
    'catalog-exact',
    'catalog-family',
    'none',
  ])
})

test('ServerHardwareProfileUpdateRequest documents exactly the parser-accepted fields and rejects unknowns', () => {
  const schema = metricsSchemas.ServerHardwareProfileUpdateRequest as SchemaObject
  assertEquals(
    Object.keys(schema.properties!).sort(),
    Object.keys(HARDWARE_PROFILE_UPDATE_KEYS).sort()
  )
  assertEquals(schema.additionalProperties, false)
  // cpuModel is a detected fact, never accepted through the PUT body.
  assertEquals('cpuModel' in schema.properties!, false)
})

test('ServerHardwareProfile response schema includes the read-only cpuModel field', () => {
  const schema = metricsSchemas.ServerHardwareProfile as SchemaObject
  assertExists(schema.properties?.cpuModel)
  assertExists(schema.properties?.cpuTdpWattsOverride)
  assertExists(schema.properties?.cpuTjMaxCelsiusOverride)
})

test('hardware-profile PUT documents 200/400/401/403/404/409/503 and the update/response schemas', () => {
  const put = (
    metricsPaths['/api/client/v1/servers/{id}/metrics/hardware-profile'] as {
      put: {
        requestBody: { content: { 'application/json': { schema: SchemaObject } } }
        responses: Record<string, unknown>
      }
    }
  ).put
  assertEquals(
    put.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/ServerHardwareProfileUpdateRequest'
  )
  assertEquals(Object.keys(put.responses).sort(), ['200', '400', '401', '403', '404', '409', '503'])
})
