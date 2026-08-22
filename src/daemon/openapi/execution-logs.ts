import { MAX_EXECUTION_LOG_CHUNK_BYTES } from "../../lib/execution-logs/types.ts";

export const executionLogSchemas = {
  DaemonExecutionLogChunk: {
    type: "object",
    required: ["seq", "bytes"],
    properties: {
      seq: {
        type: "integer",
        minimum: 0,
        description:
          "Zero-based, gap-free chunk sequence for this command. Replaying a seq already accepted is a no-op; skipping one is rejected with 409 and the expected seq.",
      },
      bytes: {
        type: "string",
        contentEncoding: "base64",
        description:
          `Standard base64 of this chunk's raw transcript bytes. Decoded size must not exceed ${MAX_EXECUTION_LOG_CHUNK_BYTES} bytes.`,
      },
    },
  },
  DaemonExecutionLogAcceptedResponse: {
    type: "object",
    required: ["ok", "nextSeq"],
    properties: {
      ok: { type: "boolean", const: true },
      nextSeq: {
        type: "integer",
        description: "Sequence number the daemon must use for its next chunk.",
      },
    },
  },
  DaemonExecutionLogConflictResponse: {
    type: "object",
    required: ["ok", "error"],
    properties: {
      ok: { type: "boolean", const: false },
      error: { type: "string", enum: ["seq gap", "log sealed"] },
      nextSeq: {
        type: "integer",
        description: "On a seq gap, the sequence to resend from.",
      },
    },
  },
};

export const executionLogPaths: Record<string, unknown> = {
  "/api/daemon/v1/commands/{commandId}/log": {
    post: {
      tags: ["Daemon"],
      summary: "Append a command execution transcript chunk",
      description:
        "Streams command stdout/stderr to the control plane while the command runs. Chunks are stored keyed by (commandId, seq) and compacted into one gzipped object when the command reaches a terminal status. Idempotent under retry: a replayed seq returns the current nextSeq unchanged.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "commandId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description:
            "Command id. Must belong to the server named by the JWT `sub`.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/DaemonExecutionLogChunk",
            },
          },
        },
      },
      responses: {
        "202": {
          description: "Chunk accepted",
          content: {
            "application/json": {
              schema: {
                $ref:
                  "#/components/schemas/DaemonExecutionLogAcceptedResponse",
              },
            },
          },
        },
        "400": { description: "Invalid chunk body" },
        "401": { description: "Missing or invalid daemon JWT" },
        "403": {
          description:
            "Command is unknown or belongs to another server (indistinguishable by design)",
        },
        "409": {
          description: "Sequence gap, or the transcript is already sealed",
          content: {
            "application/json": {
              schema: {
                $ref:
                  "#/components/schemas/DaemonExecutionLogConflictResponse",
              },
            },
          },
        },
        "413": { description: "Request body exceeds the chunk budget" },
        "429": { description: "Rate limited" },
        "503": {
          description: "Database or execution-log storage unavailable",
        },
      },
    },
  },
};
