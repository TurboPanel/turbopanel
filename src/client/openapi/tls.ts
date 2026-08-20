/**
 * Org-scoped TLS library OpenAPI schemas (`/api/client/v1/tls`).
 *
 * Distinct from the instance-wide platform CA under `<stateDir>/tls/` — these
 * documents must never describe or write platform CA paths used for daemon trust.
 */
export const tlsSchemas = {
  TlsMetadata: {
    type: "object",
    required: [
      "dnsNames",
      "hasWildcard",
      "notBefore",
      "notAfter",
      "fingerprintSha256",
      "subject",
      "issuer",
      "status",
    ],
    properties: {
      dnsNames: { type: "array", items: { type: "string" } },
      hasWildcard: { type: "boolean" },
      notBefore: { type: "string", format: "date-time" },
      notAfter: {
        type: "string",
        format: "date-time",
        description:
          "Column value mirrored into metadata for API stability (shape unchanged).",
      },
      fingerprintSha256: {
        type: "string",
        description:
          "Column value mirrored into metadata for API stability (shape unchanged).",
      },
      subject: { type: "string" },
      issuer: { type: "string" },
      status: {
        type: "string",
        enum: ["ready", "pending", "expired", "failed", "revoked"],
        description:
          "Column value mirrored into metadata for API stability (shape unchanged).",
      },
    },
  },
  TlsRow: {
    type: "object",
    required: [
      "id",
      "organizationId",
      "source",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      organizationId: { type: "string" },
      displayName: { type: ["string", "null"] },
      source: {
        type: "string",
        enum: ["upload", "lets_encrypt", "self_signed", "organization_ca"],
      },
      metadata: { $ref: "#/components/schemas/TlsMetadata" },
      options: { type: ["object", "null"] },
      certificatePem: {
        type: ["string", "null"],
        description:
          "Public certificate chain PEM (private key is never returned)",
      },
      trustBundlePem: {
        type: "string",
        description:
          "Active+retired Organization CA PEM bundle. Present on GET /tls/ca only.",
      },
      caGeneration: {
        type: ["integer", "null"],
        description:
          "Active Organization CA generation. Null for non-CA library rows.",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  TlsListResponse: {
    type: "object",
    required: ["tls"],
    properties: {
      tls: {
        type: "array",
        items: { $ref: "#/components/schemas/TlsRow" },
      },
    },
  },
  CreateTlsRequest: {
    type: "object",
    required: ["source"],
    properties: {
      source: {
        type: "string",
        enum: ["upload", "lets_encrypt", "self_signed", "organization_ca"],
      },
      displayName: { type: "string" },
      certificatePem: {
        type: "string",
        description: "Required for source=upload",
      },
      privateKeyPem: {
        type: "string",
        description: "Required for source=upload (write-only)",
      },
      hostnames: {
        type: "array",
        items: { type: "string" },
        description: "Required for lets_encrypt and self_signed",
      },
      commonName: {
        type: "string",
        description: "Optional CN for source=organization_ca",
      },
      prefer: { type: "number" },
      autoRenew: { type: "boolean" },
      challengeType: { type: "string", enum: ["http-01", "dns-01"] },
    },
  },
  PatchTlsRequest: {
    type: "object",
    properties: {
      displayName: { type: "string" },
      prefer: { type: ["number", "null"] },
      autoRenew: { type: "boolean" },
      revoke: {
        type: "boolean",
        description:
          "Revoke a library certificate (upload, self-signed, or Let's Encrypt). Organization CA rows cannot be revoked here — use POST /tls/ca/retire after rotation converges.",
      },
    },
  },
  TlsCaRotationResult: {
    type: "object",
    required: ["serverId", "status"],
    properties: {
      serverId: { type: "string", format: "uuid" },
      kind: {
        type: "string",
        enum: ["apply", "ingress", "binding"],
        description:
          "Fan-out row kind. Duplicate serverId entries remain distinguishable by kind and managedId.",
      },
      managedId: {
        type: "string",
        format: "uuid",
        description: "Managed cluster id for apply/binding rows",
      },
      status: { type: "string" },
      commandId: { type: "string", format: "uuid" },
      error: { type: "string" },
    },
  },
  TlsCaRotateResponse: {
    type: "object",
    required: ["ok", "id", "rotationId", "generation", "results"],
    properties: {
      ok: { type: "boolean" },
      id: {
        type: "string",
        format: "uuid",
        description: "New active Organization CA row id",
      },
      rotationId: { type: "string", format: "uuid" },
      generation: { type: "integer" },
      results: {
        type: "array",
        items: { $ref: "#/components/schemas/TlsCaRotationResult" },
      },
      needsRedeploy: {
        type: "array",
        items: {
          type: "object",
          required: ["serverId", "environmentId"],
          properties: {
            serverId: { type: "string", format: "uuid" },
            environmentId: { type: "string", format: "uuid" },
          },
        },
        description:
          "Consumer environments whose binding CA material changed; rotate does not enqueue environment.deploy",
      },
    },
  },
  TlsCaRotationStatus: {
    type: "object",
    required: [
      "rotationId",
      "fromGeneration",
      "toGeneration",
      "state",
      "results",
      "retiredCaStillRequired",
    ],
    properties: {
      rotationId: { type: "string", format: "uuid" },
      fromGeneration: { type: "integer" },
      toGeneration: { type: "integer" },
      state: {
        type: "string",
        enum: ["in_progress", "awaiting_retire", "completed", "failed"],
      },
      results: {
        type: "array",
        items: { $ref: "#/components/schemas/TlsCaRotationResult" },
      },
      retiredCaStillRequired: {
        type: "boolean",
        description: "True whenever state is not completed",
      },
    },
  },
};

export const tlsPaths = {
  "/api/client/v1/tls": {
    get: {
      tags: ["TLS"],
      summary: "List organization TLS certificates",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: "TLS library",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TlsListResponse" },
            },
          },
        },
      },
    },
    post: {
      tags: ["TLS"],
      summary:
        "Create a TLS certificate (upload, self-signed, organization CA, or LE pending)",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateTlsRequest" },
          },
        },
      },
      responses: {
        200: {
          description: "Created",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EntityOkResponse" },
            },
          },
        },
        409: {
          description:
            "tls_fingerprint_conflict or organization_ca_exists (active CA already present)",
        },
      },
    },
  },
  "/api/client/v1/tls/ca": {
    get: {
      tags: ["TLS"],
      summary:
        "Ensure or return the organization CA certificate (create if missing)",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description:
            "Active Organization CA (public fields) plus the active+retired trust bundle",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tls", "trustBundlePem", "leafHealth"],
                properties: {
                  tls: { $ref: "#/components/schemas/TlsRow" },
                  trustBundlePem: {
                    type: "string",
                    description:
                      "Concatenated active+retired Organization CA PEMs so clients can pre-trust the overlap window. Multi-PEM is accepted by ProxySQL ssl_ca and Postgres ssl_ca_file.",
                  },
                  leafHealth: {
                    type: "object",
                    required: ["dueCount", "caGeneration", "caNotAfter"],
                    properties: {
                      dueCount: {
                        type: "integer",
                        description:
                          "Organization-CA-signed managed leaves in this org that are inside the renewal window (remaining lifetime < issued lifetime / 3) or were signed by a retired generation.",
                      },
                      caGeneration: {
                        type: "integer",
                        description:
                          "Generation of the active Organization CA signer.",
                      },
                      caNotAfter: {
                        type: ["string", "null"],
                        format: "date-time",
                        description:
                          "Expiry of the active Organization CA certificate.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/tls/ca/rotate": {
    post: {
      tags: ["TLS"],
      summary:
        "Begin Organization CA rotation: mint generation N+1, retire N, journal + fan-out",
      description:
        "Lease-guarded. Mints a new active Organization CA, retires the prior generation into the overlap trust bundle, records a `tlsrotation` journal row, and fans one bounded batch of `managed.apply` / `managed.ingress.reconcile` (plus binding rematerialize) across the org. Repeat POST while `in_progress` to resume from the stored cursor without minting another generation. Does not enqueue `environment.deploy`. Concurrent rotate while `awaiting_retire` (or mint still in flight) returns 409 `ca_rotation_in_progress`.",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description:
            "Rotation started, resumed, or fan-out completed into awaiting_retire",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TlsCaRotateResponse" },
            },
          },
        },
        409: {
          description:
            "ca_rotation_in_progress (awaiting_retire, or mint still in flight) or tls_fingerprint_conflict",
        },
      },
    },
  },
  "/api/client/v1/tls/ca/rotation": {
    get: {
      tags: ["TLS"],
      summary: "Latest Organization CA rotation journal for this organization",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description:
            "Latest rotation journal (command statuses overlaid when known)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TlsCaRotationStatus" },
            },
          },
        },
        404: {
          description: "No rotation has been started for this organization",
        },
      },
    },
  },
  "/api/client/v1/tls/ca/retire": {
    post: {
      tags: ["TLS"],
      summary:
        "Revoke retired Organization CA generations after rotation commands succeed",
      description:
        "Requires the latest journal row to be `awaiting_retire` and every tracked command to have status `succeeded` (binding rematerialize failures also block). Sets every `ca_state=retired` Organization CA row for the org to `revoked` and marks the journal `completed`.",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: "Retired generations revoked; overlap window closed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "rotationId"],
                properties: {
                  ok: { type: "boolean" },
                  rotationId: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
        409: {
          description:
            "no_pending_rotation (no awaiting_retire journal) or ca_rotation_not_converged (a tracked command is missing, non-terminal, or not succeeded, or binding rematerialize failed)",
        },
      },
    },
  },
  "/api/client/v1/tls/ca/download": {
    get: {
      tags: ["TLS"],
      summary: "Download the organization CA trust-bundle PEM",
      description:
        "Returns the concatenated active+retired Organization CA PEMs as `application/x-pem-file` so clients can pre-trust the overlap window. Private key is never included.",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: "Organization CA trust-bundle PEM (active+retired)",
          content: {
            "application/x-pem-file": {
              schema: { type: "string" },
            },
          },
        },
        404: {
          description: "No active organization CA",
        },
      },
    },
  },
  "/api/client/v1/tls/{id}": {
    get: {
      tags: ["TLS"],
      summary: "Get a TLS certificate (no private key)",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "TLS certificate",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tls"],
                properties: {
                  tls: { $ref: "#/components/schemas/TlsRow" },
                },
              },
            },
          },
        },
      },
    },
    patch: {
      tags: ["TLS"],
      summary: "Update TLS display name / prefer / revoke (library certs only)",
      description:
        "Revoke applies to upload / self-signed / Let's Encrypt library rows. Organization CA retirement is exclusively POST /tls/ca/retire; PATCH with revoke:true on an Organization CA returns 409 organization_ca_retire_required.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/PatchTlsRequest" },
          },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdateEntityOkResponse" },
            },
          },
        },
        409: {
          description:
            "organization_ca_retire_required (PATCH cannot revoke an Organization CA)",
        },
      },
    },
    delete: {
      tags: ["TLS"],
      summary: "Delete a TLS certificate (clears hosting pins)",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Deleted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdateEntityOkResponse" },
            },
          },
        },
      },
    },
  },
};
