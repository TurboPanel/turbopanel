import { HOST_METRIC_KEYS, type HostMetricKey } from '../../daemon/metrics/contract.ts'
import {
  HARDWARE_PROFILE_NIC_KEYS,
  HARDWARE_PROFILE_SENSOR_SLOT_KEYS,
} from '../../lib/db/server-metadata.ts'
import { clientErrorJson } from './shared.ts'

const hostMetricValueProperties = Object.fromEntries(
  HOST_METRIC_KEYS.map((key) => [key, { type: ['number', 'null'] as const }])
) as Record<HostMetricKey, { type: readonly ['number', 'null'] }>

const sensorSlotOrNullSchema = {
  oneOf: [{ $ref: '#/components/schemas/ServerSensorSlotAssignment' }, { type: 'null' }],
  description:
    'Assignment pins the sensor identity; `null` marks it explicitly unassigned; omit to leave untouched.',
}

const nicOrNullSchema = {
  type: ['string', 'null'],
  description: 'Network interface name; `null` unassigns; omit to leave untouched.',
}

const sensorSlotProperties = Object.fromEntries(
  HARDWARE_PROFILE_SENSOR_SLOT_KEYS.map((key) => [key, sensorSlotOrNullSchema])
)

const nicProperties = Object.fromEntries(
  HARDWARE_PROFILE_NIC_KEYS.map((key) => [key, nicOrNullSchema])
)

/**
 * Fields {@link ServerHardwareProfile} carries once persisted — same slot/NIC
 * shape as the update request, plus generation bookkeeping and the
 * daemon-detected `cpuModel` (never accepted through the PUT body).
 */
const hardwareProfileProperties = {
  ...sensorSlotProperties,
  ...nicProperties,
  hostingPath: { type: 'string' },
  drivetempEnabled: { type: 'boolean' },
  generation: {
    type: 'integer',
    description: 'Monotonically increasing; bumps only when a sensor/NIC identity changes.',
  },
  generationAppliedAt: { type: 'string', format: 'date-time' },
  cpuModel: {
    type: 'string',
    description:
      'Detected CPU model reported by the daemon’s host-facts projection — read-only, never accepted via PUT.',
  },
  cpuTdpWattsOverride: { type: ['number', 'null'] },
  cpuTjMaxCelsiusOverride: { type: ['number', 'null'] },
}

export const metricsSchemas = {
  ServerSensorSlotAssignment: {
    type: 'object',
    required: ['chip', 'label'],
    properties: {
      chip: { type: 'string' },
      label: { type: 'string' },
    },
  },
  HostMetricValues: {
    type: 'object',
    description:
      'Raw per-metric values keyed by HostMetricKey — only requested/collected keys are guaranteed present.',
    properties: hostMetricValueProperties,
    additionalProperties: false,
  },
  HostSeriesChartPointDerived: {
    type: 'object',
    description:
      'Server-computed presentation values so the UI never reimplements CPU busy / memory-swap-storage used / HTTP error rate / average latency, or CPU thermal/power headroom. A value is `null` whenever an input it needs is missing.',
    required: [
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
    ],
    properties: {
      cpuUsagePercent: { type: ['number', 'null'] },
      memoryUsedBytes: { type: ['number', 'null'] },
      memoryUsedPercent: { type: ['number', 'null'] },
      swapUsedBytes: { type: ['number', 'null'] },
      swapUsedPercent: { type: ['number', 'null'] },
      systemStorageUsedBytes: { type: ['number', 'null'] },
      systemStorageUsedPercent: { type: ['number', 'null'] },
      hostingStorageUsedBytes: { type: ['number', 'null'] },
      hostingStorageUsedPercent: { type: ['number', 'null'] },
      dockerStorageUsedBytes: { type: ['number', 'null'] },
      dockerStorageUsedPercent: { type: ['number', 'null'] },
      httpErrorRatePercent: { type: ['number', 'null'] },
      httpAverageLatencyMs: { type: ['number', 'null'] },
      cpuThermalHeadroomPercent: {
        type: ['number', 'null'],
        description:
          '`null` when cpuLimits has no resolved Tjmax for this host, or the point has no temperature reading.',
      },
      cpuPowerHeadroomPercent: {
        type: ['number', 'null'],
        description:
          '`null` when cpuLimits has no resolved TDP for this host, or the point has no power reading.',
      },
    },
  },
  HostSeriesChartPoint: {
    type: 'object',
    required: ['at', 'values', 'derived', 'sampleCount'],
    properties: {
      at: { type: 'string', format: 'date-time' },
      values: { $ref: '#/components/schemas/HostMetricValues' },
      minimums: {
        $ref: '#/components/schemas/HostMetricValues',
        description:
          'Deferred — not populated until min/max aggregates are unified across backends.',
      },
      maximums: {
        $ref: '#/components/schemas/HostMetricValues',
        description:
          'Deferred — not populated until min/max aggregates are unified across backends.',
      },
      derived: { $ref: '#/components/schemas/HostSeriesChartPointDerived' },
      sampleCount: { type: 'integer' },
      expectedSampleCount: { type: 'integer' },
      hardwareProfileGeneration: {
        type: ['integer', 'null'],
        description:
          'Hardware-profile generation shared by every contributing sample in this bucket. Omitted when the backend doesn’t track generations.',
      },
    },
  },
  EffectiveCpuThermalLimits: {
    type: 'object',
    required: ['tdpWatts', 'tjMaxCelsius', 'source'],
    properties: {
      tdpWatts: { type: ['number', 'null'] },
      tjMaxCelsius: { type: ['number', 'null'] },
      source: {
        type: 'string',
        enum: ['override', 'catalog-exact', 'catalog-family', 'none'],
        description:
          'Where the limits came from: an operator override, an exact/family CPU-catalog match, or none resolved.',
      },
    },
  },
  HostSeriesChartResponse: {
    type: 'object',
    required: [
      'ok',
      'serverId',
      'from',
      'to',
      'resolutionSeconds',
      'backend',
      'available',
      'metrics',
      'sampleCount',
      'gapCount',
      'points',
      'generationBreaks',
      'cpuLimits',
      'temperatureUnit',
      'sensorsAvailable',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string', format: 'uuid' },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      resolutionSeconds: { type: ['integer', 'null'] },
      backend: { type: 'string', enum: ['disabled', 'analytics-engine', 'duckdb'] },
      available: { type: 'boolean' },
      metrics: { type: 'array', items: { type: 'string', enum: [...HOST_METRIC_KEYS] } },
      sampleCount: { type: 'integer' },
      gapCount: { type: 'integer' },
      points: { type: 'array', items: { $ref: '#/components/schemas/HostSeriesChartPoint' } },
      generationBreaks: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'Point indices where hardwareProfileGeneration differs from the previous known generation — a chart-continuity boundary marker.',
      },
      hardwareProfileGenerations: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'Distinct hardware-profile generations observed anywhere in the queried range. Omitted when the backend doesn’t track generations.',
      },
      cpuLimits: { $ref: '#/components/schemas/EffectiveCpuThermalLimits' },
      temperatureUnit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      sensorsAvailable: {
        type: 'boolean',
        description:
          'True when at least one point in the queried range declared the "sensors" part.',
      },
    },
  },
  HostSummaryChartResponse: {
    type: 'object',
    required: [
      'ok',
      'serverId',
      'from',
      'to',
      'backend',
      'available',
      'sampleCount',
      'latestAt',
      'cpuLimits',
      'temperatureUnit',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string', format: 'uuid' },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      backend: { type: 'string', enum: ['disabled', 'analytics-engine', 'duckdb'] },
      available: { type: 'boolean' },
      sampleCount: { type: 'integer' },
      latestAt: { type: ['string', 'null'], format: 'date-time' },
      cpuLimits: { $ref: '#/components/schemas/EffectiveCpuThermalLimits' },
      temperatureUnit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
  },
  StatusHistoryEvent: {
    type: 'object',
    required: ['at', 'connected', 'reason'],
    properties: {
      at: { type: 'string', format: 'date-time' },
      connected: { type: 'boolean' },
      reason: { type: 'string', enum: ['connect', 'disconnect', 'sweep_stale', 'self_heal'] },
    },
  },
  ConnectionHistoryChartResponse: {
    type: 'object',
    required: [
      'ok',
      'serverId',
      'from',
      'to',
      'backend',
      'available',
      'initialConnected',
      'uptimeSeconds',
      'downtimeSeconds',
      'unknownSeconds',
      'uptimePercent',
      'truncated',
      'events',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string', format: 'uuid' },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      backend: { type: 'string', enum: ['disabled', 'analytics-engine', 'duckdb'] },
      available: { type: 'boolean' },
      initialConnected: {
        type: ['boolean', 'null'],
        description: '`null` means the connection state before `from` is unknown.',
      },
      uptimeSeconds: { type: 'number' },
      downtimeSeconds: { type: 'number' },
      unknownSeconds: { type: 'number' },
      uptimePercent: { type: ['number', 'null'] },
      truncated: { type: 'boolean' },
      events: { type: 'array', items: { $ref: '#/components/schemas/StatusHistoryEvent' } },
    },
  },
  MetricsBackendUnavailableResponse: {
    type: 'object',
    required: ['ok', 'error', 'backend'],
    properties: {
      ok: { type: 'boolean', const: false },
      error: { type: 'string', const: 'metrics_backend_unavailable' },
      backend: { type: 'string', enum: ['disabled', 'analytics-engine', 'duckdb'] },
    },
  },
  ServerHardwareProfileUpdateRequest: {
    type: 'object',
    description:
      'PUT body for the operator-assigned hardware profile. Per field: an assignment pins it, `null` clears/unassigns it, an absent field leaves it untouched. Unknown fields (including `cpuModel`, which is detected, not operator-set) are rejected.',
    properties: {
      ...sensorSlotProperties,
      ...nicProperties,
      hostingPath: {
        type: ['string', 'null'],
        description: 'Absolute path without whitespace; `null` clears it.',
      },
      drivetempEnabled: { type: ['boolean', 'null'] },
      cpuTdpWattsOverride: {
        type: ['number', 'null'],
        description: 'Greater than 0 and at most 1000; `null` clears the override.',
      },
      cpuTjMaxCelsiusOverride: {
        type: ['number', 'null'],
        description: 'Between 40 and 130; `null` clears the override.',
      },
    },
    additionalProperties: false,
  },
  ServerHardwareProfile: {
    type: 'object',
    properties: hardwareProfileProperties,
  },
  ServerHardwareProfileUpdateResponse: {
    type: 'object',
    required: ['ok', 'profile', 'pushed'],
    properties: {
      ok: { type: 'boolean', const: true },
      profile: { $ref: '#/components/schemas/ServerHardwareProfile' },
      pushed: {
        type: 'boolean',
        description:
          'Whether the profile was pushed to a connected daemon (best-effort — false when the daemon is offline or the registry is unavailable).',
      },
    },
  },
}

const serverIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
}

const fromToParams = [
  {
    name: 'from',
    in: 'query',
    required: true,
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to',
    in: 'query',
    required: true,
    schema: { type: 'string', format: 'date-time' },
  },
]

const metricsQueryErrorResponses = {
  '400': {
    description: 'Invalid from/to range, metrics list, or maxPoints',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '401': {
    description: 'Unauthorized',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '403': {
    description: 'Forbidden',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '503': {
    description: 'Database or metrics backend unavailable',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/MetricsBackendUnavailableResponse' },
      },
    },
  },
}

export const metricsPaths: Record<string, unknown> = {
  '/api/client/v1/servers/{id}/metrics/series': {
    get: {
      tags: ['Servers'],
      summary: 'Get charted host-metrics series for a visible server',
      description:
        'Bucketed series with derived presentation values and CPU thermal/power headroom, resolved from the server’s hardware profile.',
      security: [{ cookieAuth: [] }],
      parameters: [
        serverIdParam,
        ...fromToParams,
        {
          name: 'metrics',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'Comma-separated HostMetricKey allowlist; omit for all metrics.',
        },
        {
          name: 'resolution',
          in: 'query',
          required: false,
          schema: { type: 'integer' },
          description: 'Bucket width in seconds; omit to auto-select from the range and maxPoints.',
        },
        {
          name: 'maxPoints',
          in: 'query',
          required: false,
          schema: { type: 'integer' },
        },
      ],
      responses: {
        '200': {
          description: 'Host metrics series',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HostSeriesChartResponse' },
            },
          },
        },
        ...metricsQueryErrorResponses,
      },
    },
  },
  '/api/client/v1/servers/{id}/metrics/summary': {
    get: {
      tags: ['Servers'],
      summary: 'Get host-metrics summary (sample count, latest sample) for a visible server',
      security: [{ cookieAuth: [] }],
      parameters: [serverIdParam, ...fromToParams],
      responses: {
        '200': {
          description: 'Host metrics summary',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HostSummaryChartResponse' },
            },
          },
        },
        ...metricsQueryErrorResponses,
      },
    },
  },
  '/api/client/v1/servers/{id}/metrics/connection': {
    get: {
      tags: ['Servers'],
      summary: 'Get connection uptime/downtime history for a visible server',
      security: [{ cookieAuth: [] }],
      parameters: [serverIdParam, ...fromToParams],
      responses: {
        '200': {
          description: 'Connection history and uptime totals',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ConnectionHistoryChartResponse' },
            },
          },
        },
        ...metricsQueryErrorResponses,
      },
    },
  },
  '/api/client/v1/servers/{id}/metrics/hardware-profile': {
    put: {
      tags: ['Servers'],
      summary: 'Set the operator-assigned hardware profile for a server',
      description:
        'Persists sensor-slot/NIC assignments, hosting path, drivetemp opt-in, and CPU TDP/Tjmax overrides. Assigning a sensor/NIC identity is validated against a fresh daemon capability round trip and requires the daemon to be connected; clearing slots or touching hostingPath/drivetempEnabled/overrides does not.',
      security: [{ cookieAuth: [] }],
      parameters: [serverIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ServerHardwareProfileUpdateRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Hardware profile saved',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServerHardwareProfileUpdateResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid body, unknown field, or a stale sensor/NIC identity',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '401': {
          description: 'Unauthorized',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '403': {
          description: 'Forbidden — requires organization:manage',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '404': {
          description: 'Server not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '409': {
          description: 'Server offline — required for identity validation',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '503': {
          description: 'Database or daemon cell registry unavailable',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
}
