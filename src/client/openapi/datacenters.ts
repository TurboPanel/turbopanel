const errorBody = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
};

export const datacenterSchemas = {
  DatacenterRow: {
    type: "object",
    required: ["id", "organizationId", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      organizationId: { type: "string", format: "uuid" },
      displayName: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
      options: { type: ["object", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  DatacentersResponse: {
    type: "object",
    required: ["datacenters"],
    properties: {
      datacenters: {
        type: "array",
        items: { $ref: "#/components/schemas/DatacenterRow" },
      },
    },
  },
  DatacenterResponse: {
    type: "object",
    required: ["datacenter"],
    properties: {
      datacenter: { $ref: "#/components/schemas/DatacenterRow" },
    },
  },
  CreateDatacenterRequest: {
    type: "object",
    properties: {
      displayName: { type: "string" },
      description: { type: "string" },
      metadata: { type: "object" },
      options: { type: "object" },
      sourceServerId: {
        type: "string",
        format: "uuid",
        description:
          "When displayName is omitted, seed the name and metadata.geo from this server",
      },
      assignServerIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        description:
          "Member servers to pin to the new datacenter (includes sourceServerId when set)",
      },
    },
  },
  PatchDatacenterRequest: {
    type: "object",
    properties: {
      displayName: { type: "string" },
      description: { type: "string" },
      metadata: { type: ["object", "null"] },
      options: { type: ["object", "null"] },
    },
  },
  DatacenterNameSuggestion: {
    type: "object",
    required: [
      "displayName",
      "serverCount",
      "serverIds",
      "serverLabels",
      "geo",
    ],
    properties: {
      displayName: { type: "string" },
      serverCount: { type: "integer", minimum: 1 },
      serverIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
      serverLabels: {
        type: "array",
        items: { type: "string" },
      },
      geo: { type: "object" },
    },
  },
  DatacenterNameSuggestionsResponse: {
    type: "object",
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        items: { $ref: "#/components/schemas/DatacenterNameSuggestion" },
      },
    },
  },
};

export const datacenterPaths: Record<string, unknown> = {
  "/api/client/v1/datacenters/name-suggestions": {
    get: {
      tags: ["Datacenters"],
      summary: "Suggest datacenter names from server geolocation and ASN",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: "unassignedOnly",
          in: "query",
          schema: { type: "string", enum: ["0", "1"] },
          description:
            "When omitted or not `0`, only unassigned servers are considered",
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 0, maximum: 32 },
        },
      ],
      responses: {
        "200": {
          description: "Grouped name suggestions",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/DatacenterNameSuggestionsResponse",
              },
            },
          },
        },
        "400": {
          description: "Invalid request",
          content: { "application/json": { schema: errorBody } },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: errorBody } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: errorBody } },
        },
      },
    },
  },
  "/api/client/v1/datacenters": {
    get: {
      tags: ["Datacenters"],
      summary: "List datacenters",
      security: [{ cookieAuth: [] }],
      responses: {
        "200": {
          description: "Datacenters in the session organization",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DatacentersResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: errorBody } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: errorBody } },
        },
      },
    },
    post: {
      tags: ["Datacenters"],
      summary: "Create a datacenter",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateDatacenterRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "id"],
                properties: {
                  ok: { type: "boolean", const: true },
                  id: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid request",
          content: { "application/json": { schema: errorBody } },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: errorBody } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: errorBody } },
        },
        "404": {
          description: "A requested source or member server is not visible",
          content: { "application/json": { schema: errorBody } },
        },
        "409": {
          description:
            "A requested member server already belongs to a datacenter",
          content: { "application/json": { schema: errorBody } },
        },
      },
    },
  },
  "/api/client/v1/datacenters/{id}": {
    get: {
      tags: ["Datacenters"],
      summary: "Get a datacenter",
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
          description: "Datacenter",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DatacenterResponse" },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: errorBody } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: errorBody } },
        },
        "404": {
          description: "Not found",
          content: { "application/json": { schema: errorBody } },
        },
      },
    },
    patch: {
      tags: ["Datacenters"],
      summary: "Update a datacenter",
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
            schema: { $ref: "#/components/schemas/PatchDatacenterRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", const: true } },
              },
            },
          },
        },
        "400": {
          description: "Invalid request",
          content: { "application/json": { schema: errorBody } },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: errorBody } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: errorBody } },
        },
        "404": {
          description: "Not found",
          content: { "application/json": { schema: errorBody } },
        },
      },
    },
    delete: {
      tags: ["Datacenters"],
      summary: "Delete a datacenter",
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
          description: "Deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean", const: true } },
              },
            },
          },
        },
        "401": {
          description: "Unauthorized",
          content: { "application/json": { schema: errorBody } },
        },
        "403": {
          description: "Forbidden",
          content: { "application/json": { schema: errorBody } },
        },
        "404": {
          description: "Not found",
          content: { "application/json": { schema: errorBody } },
        },
        "409": {
          description: "Datacenter still has scoped networks",
          content: { "application/json": { schema: errorBody } },
        },
      },
    },
  },
};
