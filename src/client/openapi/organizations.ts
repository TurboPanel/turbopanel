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
}
