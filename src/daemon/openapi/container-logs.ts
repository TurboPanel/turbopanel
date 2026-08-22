import {
  MAX_CONTAINER_LOG_INGEST_BATCH,
  MAX_CONTAINER_LOG_MESSAGE_BYTES,
} from "../../lib/container-logs/types.ts";

export const containerLogSchemas = {
  DaemonContainerLogEvent: {
    type: "object",
    required: ["timestamp", "containerId", "stream", "message"],
    properties: {
      timestamp: {
        type: "string",
        format: "date-time",
        description: "ISO-8601 UTC timestamp of the line.",
      },
      containerId: {
        type: "string",
        description: "Long-form Docker container id.",
      },
      environmentId: {
        type: ["string", "null"],
        format: "uuid",
        description:
          "Environment the container belongs to (`com.turbopanel.environment`), or null.",
      },
      serviceId: {
        type: ["string", "null"],
        format: "uuid",
        description:
          "Service the container belongs to (`com.turbopanel.service`), or null.",
      },
      stream: { type: "string", enum: ["stdout", "stderr"] },
      message: {
        type: "string",
        description:
          `The already-redacted line. Truncated server-side to ${MAX_CONTAINER_LOG_MESSAGE_BYTES} UTF-8 bytes.`,
      },
      serverId: {
        type: "string",
        description:
          "Ignored. The control plane stamps the server from the JWT `sub`.",
      },
      organizationId: {
        type: "string",
        description:
          "Ignored. The control plane stamps the organization from the server's row.",
      },
    },
  },
  DaemonContainerLogBatch: {
    type: "object",
    required: ["events"],
    properties: {
      events: {
        type: "array",
        maxItems: MAX_CONTAINER_LOG_INGEST_BATCH,
        items: { $ref: "#/components/schemas/DaemonContainerLogEvent" },
      },
    },
  },
  DaemonContainerLogAcceptedResponse: {
    type: "object",
    required: ["ok", "accepted"],
    properties: {
      ok: { type: "boolean", const: true },
      accepted: {
        type: "integer",
        description: "Number of events accepted from this batch.",
      },
    },
  },
};

export const containerLogPaths: Record<string, unknown> = {
  "/api/daemon/v1/logs/containers": {
    post: {
      tags: ["Daemon"],
      summary: "Ingest a batch of container log lines",
      description:
        "Batched stdout/stderr from the containers running on this host. The daemon redacts and batches; this endpoint never re-batches. " +
        "Tenancy is not negotiable: `serverId` is taken from the verified JWT `sub` and `organizationId` from that server's row — the same fields in the body are ignored. " +
        "Container logs are opt-in per organization; when the feature is off the batch is accepted and dropped, so a daemon whose flag has not yet flipped costs nothing.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/DaemonContainerLogBatch" },
          },
        },
      },
      responses: {
        "202": {
          description: "Batch accepted",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/DaemonContainerLogAcceptedResponse",
              },
            },
          },
        },
        "400": { description: "Invalid batch body" },
        "401": { description: "Missing or invalid daemon JWT" },
        "403": {
          description: "The authenticated server belongs to no organization",
        },
        "413": { description: "Request body exceeds the batch budget" },
        "429": { description: "Rate limited" },
        "503": { description: "Database unavailable" },
      },
    },
  },
};
