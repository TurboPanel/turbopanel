export const principalSchemas = {
  ProjectPrincipalRow: {
    type: "object",
    required: [
      "id",
      "kind",
      "provider",
      "username",
      "appliedUsername",
      "serviceIds",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      kind: { type: "string" },
      provider: { type: "string" },
      username: { type: "string" },
      appliedUsername: {
        type: "string",
        description:
          "Login actually created on the host: the short username plus a random _<11 chars> suffix when the org randomized-usernames default was on at create. SSH/SFTP with this name.",
      },
      projectId: { type: ["string", "null"] },
      metadata: { type: "object", nullable: true },
      options: { type: "object", nullable: true },
      serviceIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        description:
          "Services this Linux (server) user is bound to (storage owner)",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    description: "Password is never returned on GET",
  },
  ProjectPrincipalsResponse: {
    type: "object",
    required: ["principals"],
    properties: {
      principals: {
        type: "array",
        items: { $ref: "#/components/schemas/ProjectPrincipalRow" },
      },
    },
  },
  ResourceLimits: {
    type: "object",
    properties: {
      maxCpus: { type: "number" },
      maxMemoryBytes: { type: "number" },
      maxServicesPerEnvironment: { type: "number" },
    },
  },
  ResourceLimitsResponse: {
    type: "object",
    required: ["resourceLimits"],
    properties: {
      resourceLimits: { $ref: "#/components/schemas/ResourceLimits" },
    },
  },
  SaveResourceLimitsRequest: {
    type: "object",
    required: ["resourceLimits"],
    properties: {
      resourceLimits: { $ref: "#/components/schemas/ResourceLimits" },
    },
  },
  UpdateProjectPrincipalAssignmentsRequest: {
    type: "object",
    required: ["serviceIds"],
    properties: {
      serviceIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
    },
  },
};

export const principalPaths = {
  "/api/client/v1/projects/{projectId}/principals": {
    get: {
      tags: ["Principals"],
      summary: "List project principals",
      parameters: [
        {
          name: "projectId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Project principals",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ProjectPrincipalsResponse",
              },
            },
          },
        },
      },
    },
    post: {
      tags: ["Principals"],
      summary: "Create a Linux (server) user for the project",
      parameters: [
        {
          name: "projectId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["username"],
              properties: {
                username: {
                  type: "string",
                  description:
                    "Short principal name (POSIX allowlist; ≤ 28 chars, or ≤ 16 when the org randomized-usernames default is on so the random _<11 chars> applied suffix still fits). The host account is the applied username; home is /srv/users/<appliedUsername>.",
                },
                serviceIds: {
                  type: "array",
                  items: { type: "string", format: "uuid" },
                  description: "Services this Linux (server) user is bound to",
                },
                options: {
                  type: "object",
                  description: "Optional shell and other principal options",
                },
                uid: {
                  type: "integer",
                  description:
                    "Optional operator uid override, integer ≥ 15001 (both uid and gid required together; omit for host allocation)",
                },
                gid: {
                  type: "integer",
                  description:
                    "Optional operator gid override, integer ≥ 15001 (both uid and gid required together; omit for host allocation)",
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description:
            "Created Linux (server) user. uid/gid are echoed only when an explicit override was supplied.",
        },
        400: {
          description:
            "invalid_service_ids | username_reserved | username_too_long | Invalid request",
        },
        409: { description: "username_in_use" },
      },
    },
  },
  "/api/client/v1/projects/{projectId}/principals/{id}": {
    patch: {
      tags: ["Principals"],
      summary: "Replace service assignments for a Linux (server) user",
      parameters: [
        {
          name: "projectId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              $ref:
                "#/components/schemas/UpdateProjectPrincipalAssignmentsRequest",
            },
          },
        },
      },
      responses: {
        200: { description: "Updated assignments" },
        400: { description: "invalid_service_ids" },
      },
    },
  },
  "/api/client/v1/organizations/{id}/resource-limits": {
    get: {
      tags: ["Resource limits"],
      summary: "Get organization resource limits",
      parameters: [{
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      }],
      responses: {
        200: {
          description: "Organization limits",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ResourceLimitsResponse" },
            },
          },
        },
      },
    },
    put: {
      tags: ["Resource limits"],
      summary: "Update organization resource limits",
      parameters: [{
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SaveResourceLimitsRequest" },
          },
        },
      },
      responses: {
        200: { description: "Updated limits" },
      },
    },
  },
  "/api/client/v1/organizations/{id}/audit": {
    get: {
      tags: ["Organizations"],
      summary: "Read the organization's audit trail",
      description:
        "Security-relevant operator actions, newest first: daemon-key revokes, server deletes, " +
        "grant changes, forge credential edits, organization gate flips. Owner only — the trail " +
        "names who did what. Keyset pagination: pass the last row's createdAt as `before`.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "before",
          in: "query",
          required: false,
          schema: { type: "string", format: "date-time" },
          description: "createdAt of the previous page's last row",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
      ],
      responses: {
        200: {
          description: "Audit entries",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["entries"],
                properties: {
                  entries: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "createdAt", "action", "targetType"],
                      properties: {
                        id: { type: "string", format: "uuid" },
                        createdAt: { type: "string", format: "date-time" },
                        actorUserId: {
                          type: "string",
                          format: "uuid",
                          nullable: true,
                        },
                        actorEmail: { type: "string", nullable: true },
                        action: { type: "string" },
                        targetType: { type: "string" },
                        targetId: {
                          type: "string",
                          format: "uuid",
                          nullable: true,
                        },
                        context: {
                          type: "object",
                          nullable: true,
                          additionalProperties: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        400: { description: "Invalid limit" },
        403: { description: "organization owner required" },
      },
    },
  },
  "/api/client/v1/organizations/{id}/compose-resource-defaults": {
    get: {
      tags: ["Resource limits"],
      summary: "Get the organization's default per-service ceiling",
      description:
        "The ceiling applied at deploy to any container service whose compose sets none " +
        "(mem_limit / cpus / deploy.resources.limits). Null when the organization has not " +
        "opted into one — the default; the compose linter still advises per service.",
      parameters: [{
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      }],
      responses: {
        200: {
          description: "Organization default, or null",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["composeDefaultResourceLimits"],
                properties: {
                  composeDefaultResourceLimits: {
                    type: "object",
                    nullable: true,
                    properties: {
                      cpus: { type: "number", exclusiveMinimum: 0 },
                      memoryBytes: { type: "integer", exclusiveMinimum: 0 },
                    },
                  },
                },
              },
            },
          },
        },
        403: { description: "organization owner required" },
        404: { description: "Not found" },
      },
    },
    put: {
      tags: ["Resource limits"],
      summary: "Set or clear the organization's default per-service ceiling",
      description:
        "Owner only. Send null to clear it. A service that declares its own ceiling is never " +
        "overridden — the default fills a gap, it does not cap anyone.",
      parameters: [{
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["composeDefaultResourceLimits"],
              properties: {
                composeDefaultResourceLimits: {
                  type: "object",
                  nullable: true,
                  properties: {
                    cpus: { type: "number", exclusiveMinimum: 0 },
                    memoryBytes: { type: "integer", exclusiveMinimum: 0 },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Updated default" },
        400: {
          description:
            "Invalid composeDefaultResourceLimits; Invalid cpus; Invalid memoryBytes; " +
            "composeDefaultResourceLimits needs cpus or memoryBytes",
        },
        403: { description: "organization owner required" },
      },
    },
  },
  "/api/client/v1/servers/{id}/resource-limits": {
    get: {
      tags: ["Resource limits"],
      summary: "Get server resource limits",
      parameters: [{
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      }],
      responses: {
        200: {
          description: "Server limits",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ResourceLimitsResponse" },
            },
          },
        },
      },
    },
    put: {
      tags: ["Resource limits"],
      summary: "Update server resource limits",
      parameters: [{
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SaveResourceLimitsRequest" },
          },
        },
      },
      responses: {
        200: { description: "Updated limits" },
      },
    },
  },
};
