export const organizationSchemas = {
  OrganizationRecord: {
    type: "object",
    required: ["id", "displayName", "createdAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      displayName: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  OrganizationsResponse: {
    type: "object",
    required: ["organizations"],
    properties: {
      organizations: {
        type: "array",
        items: { $ref: "#/components/schemas/OrganizationRecord" },
      },
    },
  },
  OrganizationResponse: {
    type: "object",
    required: ["organization"],
    properties: {
      organization: { $ref: "#/components/schemas/OrganizationRecord" },
    },
  },
  OrganizationUpdate: {
    type: "object",
    required: ["displayName"],
    properties: {
      displayName: {
        type: "string",
        minLength: 1,
        maxLength: 255,
        description:
          "Non-empty display name (any characters except control characters; ≤255). Cannot be cleared.",
      },
    },
  },
  OrganizationUpdateResponse: {
    type: "object",
    required: ["ok", "organization"],
    properties: {
      ok: { type: "boolean", const: true },
      organization: { $ref: "#/components/schemas/OrganizationRecord" },
    },
  },
  OrganizationDefaultTimezone: {
    type: "object",
    required: ["defaultServerTimezone", "enforceServerTimezone"],
    properties: {
      defaultServerTimezone: {
        type: ["string", "null"],
        description:
          "Org-wide default IANA timezone for servers without an override.",
      },
      enforceServerTimezone: {
        type: "boolean",
        description:
          "When true, the org default wins over per-server options.timezone.",
      },
    },
  },
  OrganizationDefaultTimezoneUpdate: {
    type: "object",
    properties: {
      defaultServerTimezone: {
        type: ["string", "null"],
        description: "IANA timezone from GET /timezones, or null to clear.",
      },
      enforceServerTimezone: { type: "boolean" },
    },
  },
  OrganizationDefaultEnvironment: {
    type: "object",
    required: ["defaultEnvironmentName"],
    properties: {
      defaultEnvironmentName: {
        type: ["string", "null"],
        description:
          "Org-wide name for the environment scaffolded with every new project. null/unset falls back to Production.",
      },
    },
  },
  OrganizationDefaultEnvironmentUpdate: {
    type: "object",
    required: ["defaultEnvironmentName"],
    properties: {
      defaultEnvironmentName: {
        type: ["string", "null"],
        description:
          "Non-empty display name (any characters except control characters; ≤255), or null to reset to the platform default (Production).",
      },
    },
  },
  OrganizationServerCapacity: {
    type: "object",
    required: [
      "maxServers",
      "serverCount",
      "reservedSeatCount",
      "usedSeats",
      "availableSeats",
    ],
    properties: {
      maxServers: {
        type: ["integer", "null"],
        minimum: 0,
        description:
          "Seat cap for enrolled servers + unconsumed registration keys. null = unlimited.",
      },
      serverCount: {
        type: "integer",
        minimum: 0,
        description: "Servers currently enrolled in the organization.",
      },
      reservedSeatCount: {
        type: "integer",
        minimum: 0,
        description: "Active registration keys not yet latched to a server.",
      },
      usedSeats: {
        type: "integer",
        minimum: 0,
        description: "serverCount + reservedSeatCount.",
      },
      availableSeats: {
        type: ["integer", "null"],
        minimum: 0,
        description: "Remaining seats, or null when unlimited.",
      },
    },
  },
  OrganizationServerCapacityUpdate: {
    type: "object",
    required: ["maxServers"],
    properties: {
      maxServers: {
        type: ["integer", "null"],
        minimum: 0,
        description: "Non-negative integer seat cap, or null for unlimited.",
      },
    },
  },
  TimezonesResponse: {
    type: "object",
    required: ["timezones"],
    properties: {
      timezones: {
        type: "array",
        items: { type: "string" },
        description: "Sorted IANA timezone identifiers for pickers.",
      },
    },
  },
  OrganizationFabric: {
    type: "object",
    required: ["enabled", "relays"],
    properties: {
      enabled: {
        type: "boolean",
        description:
          "Whether TurboFabric is on for this organization. Absence of a fabric row is off. Not required for single-engine Docker standalone.",
      },
      fabric: {
        type: "object",
        required: ["id", "cidr", "mtu"],
        properties: {
          id: { type: "string", format: "uuid" },
          cidr: { type: "string" },
          mtu: { type: "integer", minimum: 1280, maximum: 9000 },
          status: { type: "string" },
        },
      },
      relays: {
        type: "array",
        items: { $ref: "#/components/schemas/OrganizationFabricRelay" },
      },
    },
  },
  OrganizationFabricRelay: {
    type: "object",
    required: [
      "serverId",
      "address",
      "role",
      "advertisedCidrs",
      "resolvedAdvertisedCidrs",
      "keepalive",
      "endpointAddress",
      "resolvedEndpoint",
      "publicKey",
      "prefix",
      "hasPresharedKey",
      "segments",
      "observed",
    ],
    properties: {
      serverId: { type: "string", format: "uuid" },
      address: { type: "string" },
      role: { type: "string", enum: ["gateway", "member"] },
      advertisedCidrs: { type: "array", items: { type: "string" } },
      resolvedAdvertisedCidrs: {
        type: "array",
        items: { type: "string" },
        description:
          "The list the gateway will actually advertise — the operator override when advertisedCidrs is non-empty, otherwise the IPv4 subnets of the relay's datacenters (IPv6 subnets are excluded because host forwarding is IPv4-only).",
      },
      keepalive: { type: ["integer", "null"] },
      endpointAddress: {
        type: ["string", "null"],
        description: "Operator pin only; null means auto-derive.",
      },
      resolvedEndpoint: { type: ["string", "null"] },
      publicKey: { type: ["string", "null"] },
      prefix: { type: "string" },
      hasPresharedKey: {
        type: "boolean",
        description:
          "Whether a sealed PSK is stored. The key itself is never returned.",
      },
      segments: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "subnet"],
          properties: {
            name: { type: "string" },
            subnet: { type: "string" },
            mtu: { type: "integer" },
            gateway: { type: "string" },
          },
        },
      },
      observed: {
        type: ["object", "null"],
        properties: {
          lastHandshakeAt: { type: "string", format: "date-time" },
          transferRx: { type: "integer", minimum: 0 },
          transferTx: { type: "integer", minimum: 0 },
        },
      },
    },
  },
  OrganizationFabricRelayUpdate: {
    type: "object",
    properties: {
      role: { type: "string", enum: ["gateway", "member"] },
      advertisedCidrs: {
        type: "array",
        items: { type: "string" },
        description:
          "empty list = derive from the relay's datacenter IPv4 subnets",
      },
      keepalive: { type: ["integer", "null"], minimum: 1, maximum: 65535 },
      endpointAddress: { type: ["string", "null"] },
      presharedKey: {
        type: ["string", "null"],
        description: "Write-only WireGuard PSK. Never echoed on GET.",
      },
    },
  },
  OrganizationFabricApplyResult: {
    type: "object",
    required: ["ok", "fabricId", "interfaceName", "results"],
    properties: {
      ok: { type: "boolean" },
      fabricId: { type: "string", format: "uuid" },
      interfaceName: { type: "string", enum: ["tp0"] },
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["serverId", "status"],
          properties: {
            serverId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["queued", "failed", "skipped"] },
            commandId: { type: "string", format: "uuid" },
            error: { type: "string" },
          },
        },
      },
    },
  },
  OrganizationFabricUpdate: {
    type: "object",
    required: ["enabled"],
    properties: {
      enabled: {
        type: "boolean",
        description: "Enable or disable TurboFabric for the organization.",
      },
    },
  },
};

export const organizationPaths: Record<string, unknown> = {
  "/api/client/v1/organizations": {
    get: {
      tags: ["Authorization"],
      summary: "List organizations visible to the signed-in user",
      description:
        "Returns organizations the user can access via team membership, grants, or platform admin role. The client selects the active organization and sends it on org-scoped requests via the X-Turbopanel-Organization-Id header.",
      security: [{ cookieAuth: [] }],
      responses: {
        "200": {
          description: "Visible organizations",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrganizationsResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/organizations/{id}": {
    get: {
      tags: ["Organizations"],
      summary: "Get an organization",
      description:
        "Returns the organization when the signed-in user can access it (team membership, owner/manager grant, or platform admin). Missing or inaccessible organizations return 404.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Organization record",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrganizationResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "404": {
          description: "Organization not found or inaccessible",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "503": {
          description: "Database unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
    patch: {
      tags: ["Organizations"],
      summary: "Rename an organization",
      description:
        "Manage-gated. Updates organization.displayName (any characters except control characters; ≤255). Names are not unique. The name cannot be cleared.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/OrganizationUpdate" },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated organization",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/OrganizationUpdateResponse",
              },
            },
          },
        },
        "400": {
          description: "Invalid displayName or body",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "404": {
          description: "Organization not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/organizations/{id}/default-timezone": {
    get: {
      tags: ["Organizations"],
      summary: "Get organization default server timezone",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Org timezone defaults",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/OrganizationDefaultTimezone",
              },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "404": {
          description: "Organization not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
    put: {
      tags: ["Organizations"],
      summary: "Update organization default server timezone",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/OrganizationDefaultTimezoneUpdate",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated org timezone defaults",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/OrganizationDefaultTimezone" },
                  {
                    type: "object",
                    required: ["ok"],
                    properties: { ok: { type: "boolean", const: true } },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid timezone or body",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/organizations/{id}/default-environment": {
    get: {
      tags: ["Organizations"],
      summary: "Get organization default environment name",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Org default environment name",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/OrganizationDefaultEnvironment",
              },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "404": {
          description: "Organization not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
    put: {
      tags: ["Organizations"],
      summary: "Update organization default environment name",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/OrganizationDefaultEnvironmentUpdate",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated org default environment name",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  {
                    $ref: "#/components/schemas/OrganizationDefaultEnvironment",
                  },
                  {
                    type: "object",
                    required: ["ok"],
                    properties: { ok: { type: "boolean", const: true } },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid defaultEnvironmentName or body",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "404": {
          description: "Organization not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/organizations/{id}/server-capacity": {
    get: {
      tags: ["Organizations"],
      summary: "Get organization server seat capacity",
      description:
        "Returns the configured maxServers cap (null = unlimited) and current seat usage. Enrolled servers and unconsumed registration keys both consume a seat.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Server seat capacity",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/OrganizationServerCapacity",
              },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "404": {
          description: "Organization not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
    put: {
      tags: ["Organizations"],
      summary: "Update organization server seat capacity",
      description:
        "Owner-only. Sets organization.options.maxServers for self-hosted control-plane quotas. Pass null for unlimited. Does not remove existing servers when lowered below current usage — only blocks new registration keys.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/OrganizationServerCapacityUpdate",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated capacity snapshot",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/OrganizationServerCapacity" },
                  {
                    type: "object",
                    required: ["ok"],
                    properties: { ok: { type: "boolean", const: true } },
                  },
                ],
              },
            },
          },
        },
        "400": {
          description: "Invalid maxServers",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/timezones": {
    get: {
      tags: ["Organizations"],
      summary: "List allowed IANA timezones",
      description:
        "Sorted timezone identifiers for pickers (Intl.supportedValuesOf with static fallback).",
      security: [{ cookieAuth: [] }],
      responses: {
        "200": {
          description: "Timezone list",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TimezonesResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/organizations/{id}/fabric": {
    get: {
      tags: ["Organizations"],
      summary: "Get TurboFabric opt-in status",
      description:
        "Manage-gated. Returns whether TurboFabric is enabled for the organization. Default is off: capable single-engine Docker standalone, no `tp0`. Enabling creates the org `fabric` row and reconciles host interface `tp0` on enrolled servers. User-facing copy is TurboFabric; backend identifiers stay `fabric` / `tp0`.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "TurboFabric status",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrganizationFabric" },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "404": {
          description: "Organization not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
    put: {
      tags: ["Organizations"],
      summary: "Enable or disable TurboFabric",
      description:
        "Manage-gated. `{ enabled: true }` creates the org fabric (if missing) and change-driven `server.fabric.reconcile` on enrolled servers. `{ enabled: false }` enqueues teardown (`tp0`, routed bridges, `TP-FORWARD`, keys, state) then deletes the fabric row and reclaims `network(kind='compose')` / `segment` rows. Does not auto-enable on install, enroll, or first deploy. Returns 409 `fabric_cidr_unavailable` / `fabric_address_pool_exhausted` when the default host CIDR cannot be allocated.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/OrganizationFabricUpdate" },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated TurboFabric status",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrganizationFabric" },
            },
          },
        },
        "400": {
          description: "Invalid request",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "409": {
          description: "CIDR or address pool unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/organizations/{id}/fabric/relays/{serverId}": {
    patch: {
      tags: ["Organizations"],
      summary: "Update a TurboFabric relay",
      description:
        "Manage-gated. Patches role, advertised CIDRs, keepalive, endpoint pin, and write-only `presharedKey`. Promoting to gateway returns 422 `gateway_datacenter_required` / `gateway_datacenter_cidr_required` when the server is not ready. Then change-driven membership reconcile. PSK is never echoed.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "serverId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/OrganizationFabricRelayUpdate",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated relay",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "relay"],
                properties: {
                  ok: { type: "boolean" },
                  relay: {
                    $ref: "#/components/schemas/OrganizationFabricRelay",
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid request",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "409": {
          description: "TurboFabric is off",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "422": {
          description:
            "`gateway_datacenter_required` / `gateway_datacenter_cidr_required`",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
  "/api/client/v1/organizations/{id}/fabric/apply": {
    post: {
      tags: ["Organizations"],
      summary: "Apply TurboFabric membership",
      description:
        "Manage-gated. Force-reconciles `server.fabric.reconcile` on every org relay. Returns per-server `results[]` (`queued` / `failed` / `skipped`). 409 when TurboFabric is off.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Apply enqueued",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/OrganizationFabricApplyResult",
              },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
        "409": {
          description: "TurboFabric is off",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      },
    },
  },
};
