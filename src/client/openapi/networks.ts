export const networkSchemas = {
  NetworkRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      serverId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  NetworksResponse: {
    type: 'object',
    required: ['networks'],
    properties: {
      networks: {
        type: 'array',
        items: { $ref: '#/components/schemas/NetworkRow' },
      },
    },
  },
  CreateNetworkRequest: {
    type: 'object',
    required: ['serverId'],
    properties: {
      serverId: { type: 'string', format: 'uuid' },
    },
  },
  CreateNetworkResponse: {
    type: 'object',
    required: ['ok', 'id'],
    properties: {
      ok: { type: 'boolean', const: true },
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const networkPaths: Record<string, unknown> = {
  '/api/client/v1/networks': {
    get: {
      tags: ['Networks'],
      summary: 'List networks for a server',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'serverId',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Networks linked to the server',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NetworksResponse' },
            },
          },
        },
        '400': {
          description: 'Missing serverId',
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
        '403': {
          description: 'Forbidden',
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
        '404': {
          description: 'Server not found',
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
    post: {
      tags: ['Networks'],
      summary: 'Create a network for a server',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateNetworkRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Network created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateNetworkResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request',
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
        '403': {
          description: 'Forbidden',
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
        '404': {
          description: 'Server not found',
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
  '/api/client/v1/networks/{id}': {
    delete: {
      tags: ['Networks'],
      summary: 'Delete a network',
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
          description: 'Network deleted',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok'],
                properties: { ok: { type: 'boolean', const: true } },
              },
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
        '403': {
          description: 'Forbidden',
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
        '404': {
          description: 'Network not found',
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
