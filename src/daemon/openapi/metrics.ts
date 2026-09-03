import {
  HOST_METRIC_KEYS,
  METRIC_PARTS,
  METRICS_SCHEMA_VERSION,
} from "../metrics/contract.ts";

const hostMetricProperties = Object.fromEntries(
  HOST_METRIC_KEYS.map((key) => [
    key,
    { type: ["number", "null"] as const },
  ]),
);

export const metricsSchemas = {
  DaemonHostMetricsFrame: {
    type: "object",
    required: [
      "type",
      "version",
      "at",
      "intervalSeconds",
      "sequence",
      "parts",
      "metrics",
      "dimensions",
    ],
    properties: {
      type: { type: "string", const: "metrics" },
      version: { type: "integer", const: METRICS_SCHEMA_VERSION },
      at: { type: "string", format: "date-time" },
      intervalSeconds: { type: "number" },
      sequence: { type: "integer" },
      parts: {
        type: "array",
        description:
          "Metric groupings collected this tick — always includes \"core\" and \"extended\".",
        items: { type: "string", enum: [...METRIC_PARTS] },
        minItems: 1,
      },
      metrics: {
        type: "object",
        description:
          "Only carries keys whose MetricPart is present in `parts` — an " +
          "absent key means \"not collected this tick\", distinct from a " +
          "validated `null` (collected, no reading available).",
        properties: hostMetricProperties,
        additionalProperties: false,
      },
      dimensions: {
        type: "object",
        required: [
          "schemaVersion",
          "collectionMode",
          "hardwareProfileGeneration",
          "trafficSources",
        ],
        properties: {
          schemaVersion: { type: "integer", const: METRICS_SCHEMA_VERSION },
          collectionMode: { type: "string", enum: ["baseline", "live"] },
          runtimeMode: { type: "string" },
          hardwareProfileGeneration: {
            type: "integer",
            description:
              "Generation of the detected hardware profile (sensor/NIC layout) at collection time.",
          },
          trafficSources: {
            type: "object",
            description:
              "Which traffic sidecars actually contributed data this tick.",
            required: ["caddy", "proxysql"],
            properties: {
              caddy: { type: "boolean" },
              proxysql: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
  DaemonMetricsAcceptedResponse: {
    type: "object",
    required: ["ok"],
    properties: {
      ok: { type: "boolean", const: true },
    },
  },
};

export const metricsPaths: Record<string, unknown> = {
  "/api/daemon/v1/metrics": {
    post: {
      tags: ["Daemon"],
      summary: "Ingest host metrics sample",
      description: "Authenticated daemon posts a v3 host-metrics frame. " +
        "serverId is taken from the JWT `sub` — never from the body. " +
        "Writes are fire-and-forget to Analytics Engine / DuckDB; " +
        "never wakes the Durable Object.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/DaemonHostMetricsFrame" },
          },
        },
      },
      responses: {
        "202": {
          description: "Metrics sample accepted",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/DaemonMetricsAcceptedResponse",
              },
            },
          },
        },
        "400": {
          description: "Invalid metrics payload",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonErrorResponse" },
            },
          },
        },
        "401": {
          description: "Missing or invalid daemon JWT",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonErrorResponse" },
            },
          },
        },
        "429": {
          description: "Rate limited",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "error"],
                properties: {
                  ok: { type: "boolean", const: false },
                  error: { type: "string", const: "rate_limited" },
                },
              },
            },
          },
        },
      },
    },
  },
};
