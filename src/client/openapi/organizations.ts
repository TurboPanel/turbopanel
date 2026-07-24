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
}

export const organizationPaths: Record<string, unknown> = {
  '/api/client/v1/organizations': {
    get: {
      tags: ['Authorization'],
      summary: 'List organizations visible to the signed-in user',
      description:
        'Returns organizations the user can access via membership, grants, or platform admin role. The client selects the active organization and sends it on org-scoped requests via the X-Turbopanel-Organization-Id header.',
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
}
