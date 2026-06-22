export const authSchemas = {
  DaemonChallengeResponse: {
    type: "object",
    required: ["challengeId", "nonce", "at", "expiresAt"],
    properties: {
      challengeId: { type: "string" },
      nonce: { type: "string" },
      at: { type: "string", format: "date-time" },
      expiresAt: { type: "string", format: "date-time" },
    },
  },
  DaemonEnrollResponse: {
    type: "object",
    required: ["serverId", "keyId"],
    properties: {
      serverId: { type: "string", format: "uuid" },
      keyId: { type: "string", format: "uuid" },
    },
  },
  DaemonSessionResponse: {
    type: "object",
    description:
      "Token is a 15-minute stateless JWT. Payload contains sub (serverId), kid (daemonKeyId), jti (correlation id), iss, aud, typ, iat, exp. No sid claim.",
    required: ["token", "expiresAt"],
    properties: {
      token: { type: "string" },
      expiresAt: { type: "string", format: "date-time" },
    },
  },
  DaemonHeartbeatResponse: {
    type: "object",
    required: ["ok"],
    properties: {
      ok: { type: "boolean", const: true },
    },
  },
  DaemonCommandsLeaseResponse: {
    type: "object",
    required: ["commands"],
    properties: {
      commands: {
        type: "array",
        items: {},
      },
    },
  },
};

export const authPaths: Record<string, unknown> = {
  "/api/daemon/v1/auth/challenge": {
    post: {
      tags: ["daemon"],
      summary: "Request an enrollment or auth challenge",
      description:
        "Without body: issues enrollment challenge. With `{ serverId, keyId }`: issues auth challenge after verifying daemon key on server row.",
      responses: {
        "200": {
          description: "Challenge issued",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonChallengeResponse" },
            },
          },
        },
      },
    },
  },
  "/api/daemon/v1/enroll": {
    post: {
      tags: ["daemon"],
      summary: "Enroll a daemon with a license and Ed25519 proof",
      responses: {
        "200": {
          description: "Enrollment accepted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonEnrollResponse" },
            },
          },
        },
      },
    },
  },
  "/api/daemon/v1/auth/session": {
    post: {
      tags: ["daemon"],
      summary: "Exchange a signed challenge for a 15-minute daemon JWT",
      description:
        "Exchange a signed challenge for a 15-minute stateless daemon JWT. Public key verified against server.daemonPublicKey. No session row stored.",
      responses: {
        "200": {
          description: "Session token issued",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonSessionResponse" },
            },
          },
        },
      },
    },
  },
  "/api/daemon/v1/heartbeat": {
    post: {
      tags: ["daemon"],
      summary: "Daemon liveness signal",
      description: "Daemon liveness signal. Validates stateless JWT only.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Heartbeat accepted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonHeartbeatResponse" },
            },
          },
        },
      },
    },
  },
  "/api/daemon/v1/commands/lease": {
    post: {
      tags: ["daemon"],
      summary: "Lease pending commands (stub)",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "No pending commands",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonCommandsLeaseResponse" },
            },
          },
        },
      },
    },
  },
};
