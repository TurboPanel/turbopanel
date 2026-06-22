export const serverSchemas = {
  ServerRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      organizationId: { type: ['string', 'null'] },
      options: { type: ['object', 'null'], additionalProperties: true },
      createdAt: { type: 'string', format: 'date-time' },
      connected: { type: 'boolean' },
      hostname: { type: ['string', 'null'] },
      remoteAddress: {
        type: ['string', 'null'],
        description:
          'Client IP as seen by the instance (X-Real-IP from Caddy). Null when offline or co-located on a Unix socket.',
      },
    },
  },
  ServersResponse: {
    type: 'object',
    required: ['servers'],
    properties: {
      servers: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServerRow' },
      },
    },
  },
}

export const serverPaths: Record<string, unknown> = {
  '/api/client/v1/servers': {
    get: {
      tags: ['client'],
      summary: 'List servers for the signed-in organization',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Organization servers with live connection state',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServersResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
}
