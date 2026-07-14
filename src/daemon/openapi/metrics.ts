import { HOST_METRIC_KEYS } from "../metrics/contract.ts";

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
      "metrics",
      "dimensions",
    ],
    properties: {
      type: { type: "string", const: "metrics" },
      version: { type: "integer", const: 1 },
      at: { type: "string", format: "date-time" },
      intervalSeconds: { type: "number" },
      sequence: { type: "integer" },
      metrics: {
        type: "object",
        required: [...HOST_METRIC_KEYS],
        properties: hostMetricProperties,
        additionalProperties: false,
      },
      dimensions: {
        type: "object",
        required: [
          "schemaVersion",
          "daemonVersion",
          "operatingSystem",
          "architecture",
          "kernelRelease",
        ],
        properties: {
          schemaVersion: { type: "integer", const: 1 },
          daemonVersion: { type: "string" },
          operatingSystem: { type: "string" },
          architecture: { type: "string" },
          kernelRelease: { type: "string" },
        },
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
      description: "Authenticated daemon posts a v1 host-metrics frame. " +
        "serverId is taken from the JWT `sub` — never from the body. " +
        "Writes are fire-and-forget to Analytics Engine / ClickHouse; " +
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
