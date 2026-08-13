export const organizationSchemas = {
  OrganizationRecord: {
    type: 'object',
    required: ['id', 'displayName', 'createdAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      displayName: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  OrganizationsResponse: {
    type: 'object',
    required: ['organizations'],
    properties: {
      organizations: {
        type: 'array',
        items: { $ref: '#/components/schemas/OrganizationRecord' },
      },
    },
  },
  OrganizationDefaultTimezone: {
    type: 'object',
    required: ['defaultServerTimezone', 'enforceServerTimezone'],
    properties: {
      defaultServerTimezone: {
        type: ['string', 'null'],
        description: 'Org-wide default IANA timezone for servers without an override.',
      },
      enforceServerTimezone: {
        type: 'boolean',
        description:
          'When true, the org default wins over per-server options.timezone.',
      },
    },
  },
  OrganizationDefaultTimezoneUpdate: {
    type: 'object',
    properties: {
      defaultServerTimezone: {
        type: ['string', 'null'],
        description: 'IANA timezone from GET /timezones, or null to clear.',
      },
      enforceServerTimezone: { type: 'boolean' },
    },
  },
  OrganizationDefaultEnvironment: {
    type: 'object',
    required: ['defaultEnvironmentName'],
    properties: {
      defaultEnvironmentName: {
        type: ['string', 'null'],
        description:
          'Org-wide name for the environment scaffolded with every new project. null/unset falls back to Production.',
      },
    },
  },
  OrganizationDefaultEnvironmentUpdate: {
    type: 'object',
    required: ['defaultEnvironmentName'],
    properties: {
      defaultEnvironmentName: {
        type: ['string', 'null'],
        description:
          'Non-empty display name (≤255; letters, numbers, spaces, dots, underscores, hyphens), or null to reset to the platform default (Production).',
      },
    },
  },
  OrganizationServerCapacity: {
    type: 'object',
    required: [
      'maxServers',
      'serverCount',
      'reservedSeatCount',
      'usedSeats',
      'availableSeats',
    ],
    properties: {
      maxServers: {
        type: ['integer', 'null'],
        minimum: 0,
        description:
          'Seat cap for enrolled servers + unconsumed registration keys. null = unlimited.',
      },
      serverCount: {
        type: 'integer',
        minimum: 0,
        description: 'Servers currently enrolled in the organization.',
      },
      reservedSeatCount: {
        type: 'integer',
        minimum: 0,
        description: 'Active registration keys not yet latched to a server.',
      },
      usedSeats: {
        type: 'integer',
        minimum: 0,
        description: 'serverCount + reservedSeatCount.',
      },
      availableSeats: {
        type: ['integer', 'null'],
        minimum: 0,
        description: 'Remaining seats, or null when unlimited.',
      },
    },
  },
  OrganizationServerCapacityUpdate: {
    type: 'object',
    required: ['maxServers'],
    properties: {
      maxServers: {
        type: ['integer', 'null'],
        minimum: 0,
        description: 'Non-negative integer seat cap, or null for unlimited.',
      },
    },
  },
  TimezonesResponse: {
    type: 'object',
    required: ['timezones'],
    properties: {
      timezones: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sorted IANA timezone identifiers for pickers.',
      },
    },
  },
  OrganizationFabric: {
    type: 'object',
    required: ['enabled'],
    properties: {
      enabled: {
        type: 'boolean',
        description:
          'Whether TurboFabric is on for this organization. Absence of a fabric row is off. Not required for single-engine Docker standalone.',
      },
      fabric: {
        type: 'object',
        required: ['id', 'cidr'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          cidr: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
  },
  OrganizationFabricUpdate: {
    type: 'object',
    required: ['enabled'],
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Enable or disable TurboFabric for the organization.',
      },
    },
  },
}

export const organizationPaths: Record<string, unknown> = {
  '/api/client/v1/organizations': {
    get: {
      tags: ['Authorization'],
      summary: 'List organizations visible to the signed-in user',
      description:
        'Returns organizations the user can access via team membership, grants, or platform admin role. The client selects the active organization and sends it on org-scoped requests via the X-Turbopanel-Organization-Id header.',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Visible organizations',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationsResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/default-timezone': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization default server timezone',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Org timezone defaults',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationDefaultTimezone' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization default server timezone',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationDefaultTimezoneUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated org timezone defaults',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/OrganizationDefaultTimezone' },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid timezone or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/default-environment': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization default environment name',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Org default environment name',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationDefaultEnvironment',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization default environment name',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationDefaultEnvironmentUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated org default environment name',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  {
                    $ref: '#/components/schemas/OrganizationDefaultEnvironment',
                  },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid defaultEnvironmentName or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/server-capacity': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization server seat capacity',
      description:
        'Returns the configured maxServers cap (null = unlimited) and current seat usage. Enrolled servers and unconsumed registration keys both consume a seat.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Server seat capacity',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationServerCapacity' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization server seat capacity',
      description:
        'Owner-only. Sets organization.options.maxServers for self-hosted control-plane quotas. Pass null for unlimited. Does not remove existing servers when lowered below current usage — only blocks new registration keys.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationServerCapacityUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated capacity snapshot',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/OrganizationServerCapacity' },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid maxServers',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/timezones': {
    get: {
      tags: ['Organizations'],
      summary: 'List allowed IANA timezones',
      description:
        'Sorted timezone identifiers for pickers (Intl.supportedValuesOf with static fallback).',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Timezone list',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TimezonesResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/fabric': {
    get: {
      tags: ['Organizations'],
      summary: 'Get TurboFabric opt-in status',
      description:
        'Manage-gated. Returns whether TurboFabric is enabled for the organization. Default is off: capable single-engine Docker standalone, no `tp0`. Enabling creates the org `fabric` row and reconciles host interface `tp0` on enrolled servers. User-facing copy is TurboFabric; backend identifiers stay `fabric` / `tp0`.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'TurboFabric status',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationFabric' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Enable or disable TurboFabric',
      description:
        'Manage-gated. `{ enabled: true }` creates the org fabric (if missing) and enqueues `server.fabric.reconcile` on enrolled servers. `{ enabled: false }` enqueues disable then deletes the fabric row (CASCADE relays/spans). Does not auto-enable on install, enroll, or first deploy. Returns 409 `fabric_cidr_unavailable` / `fabric_address_pool_exhausted` when the default host CIDR cannot be allocated.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/OrganizationFabricUpdate' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated TurboFabric status',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationFabric' },
            },
          },
        },
        '400': {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'CIDR or address pool unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
}
