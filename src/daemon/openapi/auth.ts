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
      keyId: {
        type: "string",
        format: "uuid",
        description:
          "server.daemon.key.id — the one active Ed25519 daemon identity key",
      },
    },
  },
  DaemonSessionResponse: {
    type: "object",
    description:
      "Token is a 15-minute stateless JWT. Payload contains sub (serverId), kid (server.daemon.key.id), jti (correlation id), iss, aud, typ, iat, exp. No sid claim. Revoking or replacing server.daemon.key blocks future JWT issuance; already-issued JWTs expire within 15 minutes.",
    required: ["token", "expiresAt"],
    properties: {
      token: { type: "string" },
      expiresAt: { type: "string", format: "date-time" },
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
  DaemonSecretsDecryptRequest: {
    type: "object",
    required: ["ciphertexts"],
    properties: {
      ciphertexts: {
        type: "array",
        items: { type: "string" },
        description: "Sealed tpdaemon recipient-bound envelopes to decrypt (max 100)",
      },
    },
  },
  DaemonSecretsDecryptResponse: {
    type: "object",
    description:
      "Exactly one of plaintexts or sealed. sealed is returned to a daemon that lists daemon-sealed-secrets-v1 and has registered a sealing key; plaintexts is the answer to every other daemon.",
    properties: {
      plaintexts: {
        type: "array",
        items: {
          oneOf: [{ type: "string" }, { type: "null" }],
        },
        description:
          "Order-preserving plaintexts; null when an entry fails to decrypt",
      },
      sealed: {
        type: "array",
        items: {
          oneOf: [
            { $ref: "#/components/schemas/DaemonSealedEnvelope" },
            { type: "null" },
          ],
        },
        description:
          "Order-preserving HPKE envelopes sealed to the daemon's sealing key (aad is the server id); null when an entry fails to decrypt",
      },
    },
  },
  DaemonSealedEnvelope: {
    type: "object",
    required: ["v", "kid", "enc", "ct"],
    properties: {
      v: { type: "integer", enum: [1] },
      kid: {
        type: "string",
        description: "Fingerprint of the daemon's X25519 sealing key",
      },
      enc: { type: "string", description: "base64url encapsulated key" },
      ct: { type: "string", description: "base64url ciphertext" },
    },
  },
  DaemonSealingKeyRequest: {
    type: "object",
    required: ["kid", "pub", "sig"],
    properties: {
      kid: {
        type: "string",
        description: "Fingerprint of pub (43 characters)",
      },
      pub: {
        type: "string",
        description: "base64url raw 32-byte X25519 public key",
      },
      sig: {
        type: "string",
        description:
          'base64url Ed25519 signature over "tp-sealing-key\n" + pub by the daemon key',
      },
    },
  },
  DaemonJwksResponse: {
    type: "object",
    required: ["keys"],
    properties: {
      keys: {
        type: "array",
        items: {
          type: "object",
          required: ["kty", "crv", "x", "kid", "use", "alg"],
          properties: {
            kty: { type: "string", enum: ["OKP"] },
            crv: { type: "string", enum: ["Ed25519"] },
            x: { type: "string", description: "Ed25519 public key (base64url)" },
            kid: { type: "string", description: "Signing key id (SHA-256 fingerprint of public JWK)" },
            use: { type: "string", enum: ["sig"] },
            alg: { type: "string", enum: ["EdDSA"] },
          },
        },
      },
    },
  },
};

export const authPaths: Record<string, unknown> = {
  "/api/daemon/v1/auth/challenge": {
    post: {
      tags: ["Authentication"],
      summary: "Request an enrollment or auth challenge",
      description:
        "Without body: issues enrollment challenge. With `{ serverId, keyId }`: issues auth challenge after verifying server.daemon.key (active, matching keyId) on the server row.",
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
      tags: ["Authentication"],
      summary: "Enroll a daemon with a license and Ed25519 proof",
      description:
        "Writes server.daemon.key with the submitted Ed25519 public key. Re-enrollment or recovery with a valid license replaces server.daemon entirely; old daemon keys are not kept for MVP.",
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
      tags: ["Authentication"],
      summary: "Exchange a signed challenge for a 15-minute daemon JWT",
      description:
        "Exchange a signed challenge for a 15-minute stateless daemon JWT signed with EdDSA. Public key verified against server.daemon.key.publicJwk. Records key use in Postgres (`server.daemon.key.lastUsedAt`) only — does not wake or write the daemon cell. No daemon session row stored.",
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
  "/api/daemon/v1/jwks.json": {
    get: {
      tags: ["Authentication"],
      summary: "Daemon JWT signing keys (JWKS)",
      description:
        "Returns public Ed25519 signing keys for verifying daemon JWTs (EdDSA). No private key material is exposed.",
      responses: {
        "200": {
          description: "JWKS document",
          headers: {
            "Cache-Control": {
              schema: { type: "string" },
              description: "public, max-age=300",
            },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonJwksResponse" },
            },
          },
        },
        "503": {
          description: "JWKS unavailable",
        },
      },
    },
  },
  "/api/daemon/v1/commands/lease": {
    post: {
      tags: ["Daemon"],
      summary: "Lease pending commands (stub)",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "No pending commands",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/DaemonCommandsLeaseResponse",
              },
            },
          },
        },
      },
    },
  },
  "/api/daemon/v1/secrets/decrypt": {
    post: {
      tags: ["Daemon"],
      summary: "Decrypt sealed secret envelopes (batch)",
      description:
        "Decrypts tpdaemon recipient-bound envelopes using per-daemon keys derived from the platform root secret. The daemon JWT sub/kid must match the envelope serverId/keyId. Returns null per index on failure without leaking error details.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/DaemonSecretsDecryptRequest",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Batch decrypt result",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/DaemonSecretsDecryptResponse",
              },
            },
          },
        },
      },
    },
  },
  "/api/daemon/v1/servers/self/sealing-key": {
    post: {
      tags: ["Daemon"],
      summary: "Register the daemon's X25519 sealing key",
      description:
        "Stores the public half of the daemon's sealing key after checking the Ed25519 signature against the key on file. Decrypt answers are then sealed to it when the daemon lists daemon-sealed-secrets-v1.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/DaemonSealingKeyRequest",
            },
          },
        },
      },
      responses: {
        "200": { description: "Registered" },
        "400": { description: "Malformed body or signature does not verify" },
      },
    },
  },
  "/api/daemon/v1/deployments/secrets/rehydrate": {
    post: {
      tags: ["Daemon"],
      summary: "Rehydrate deployment secret plan and envelopes",
      description:
        "Returns the last-applied secret plan plus tpdaemon envelopes for deployments on this server. Plaintext never leaves the instance; the daemon decrypts via /secrets/decrypt.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Plans and envelopes",
        },
      },
    },
  },
};
