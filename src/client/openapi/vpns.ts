const errorBody = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
}

export const vpnSchemas = {
  VpnRow: {
    type: 'object',
    required: ['id', 'organizationId', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      organizationId: { type: 'string', format: 'uuid' },
      networkId: { type: ['string', 'null'], format: 'uuid' },
      displayName: { type: ['string', 'null'] },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  PeerRow: {
    type: 'object',
    required: ['id', 'vpnId', 'serverId', 'publicKey', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      vpnId: { type: 'string', format: 'uuid' },
      serverId: { type: 'string', format: 'uuid' },
      ipId: { type: ['string', 'null'], format: 'uuid' },
      publicKey: { type: 'string' },
      tunnelAddress: { type: ['string', 'null'] },
      listenPort: { type: ['integer', 'null'] },
      endpoint: { type: ['string', 'null'] },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  VpnsResponse: {
    type: 'object',
    required: ['vpns'],
    properties: {
      vpns: { type: 'array', items: { $ref: '#/components/schemas/VpnRow' } },
    },
  },
  VpnResponse: {
    type: 'object',
    required: ['vpn'],
    properties: {
      vpn: { $ref: '#/components/schemas/VpnRow' },
    },
  },
  PeersResponse: {
    type: 'object',
    required: ['peers'],
    properties: {
      peers: { type: 'array', items: { $ref: '#/components/schemas/PeerRow' } },
    },
  },
  CreateVpnRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      networkId: { type: ['string', 'null'], format: 'uuid' },
      meshCidr: {
        type: 'string',
        description:
          'When networkId is omitted, creates a VPN-kind network with this CIDR and links it to the new mesh. Mutually exclusive with networkId.',
      },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
  PatchVpnRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      networkId: { type: ['string', 'null'], format: 'uuid' },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
    },
  },
  CreatePeerRequest: {
    type: 'object',
    required: ['serverId', 'publicKey'],
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      publicKey: { type: 'string' },
      ipId: { type: ['string', 'null'], format: 'uuid' },
      tunnelAddress: { type: 'string' },
      listenPort: { type: 'integer' },
      endpoint: { type: 'string' },
      presharedKey: { type: 'string', description: 'Write-only; sealed at rest' },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
  PatchPeerRequest: {
    type: 'object',
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      publicKey: { type: 'string' },
      ipId: { type: ['string', 'null'], format: 'uuid' },
      tunnelAddress: { type: ['string', 'null'] },
      listenPort: { type: ['integer', 'null'] },
      endpoint: { type: ['string', 'null'] },
      presharedKey: { type: ['string', 'null'], description: 'Write-only' },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
    },
  },
  WireguardApplyResponse: {
    type: 'object',
    required: ['ok', 'vpnId', 'interfaceName', 'results'],
    properties: {
      ok: { type: 'boolean', const: true },
      vpnId: { type: 'string', format: 'uuid' },
      interfaceName: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['peerId', 'serverId', 'status'],
          properties: {
            peerId: { type: 'string', format: 'uuid' },
            serverId: { type: 'string', format: 'uuid' },
            commandId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'failed'] },
            error: { type: 'string' },
          },
        },
      },
    },
  },
}

export const vpnPaths: Record<string, unknown> = {
  '/api/client/v1/vpns': {
    get: {
      tags: ['VPNs'],
      summary: 'List VPN meshes',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'VPNs',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VpnsResponse' } } },
        },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
      },
    },
    post: {
      tags: ['VPNs'],
      summary: 'Create a VPN mesh',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CreateVpnRequest' } },
        },
      },
      responses: {
        '200': {
          description: 'Created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'id'],
                properties: {
                  ok: { type: 'boolean', const: true },
                  id: { type: 'string', format: 'uuid' },
                  networkId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        '400': { description: 'Invalid request', content: { 'application/json': { schema: errorBody } } },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
      },
    },
  },
  '/api/client/v1/vpns/{id}': {
    get: {
      tags: ['VPNs'],
      summary: 'Get a VPN mesh',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'VPN',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VpnResponse' } } },
        },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: errorBody } } },
      },
    },
    patch: {
      tags: ['VPNs'],
      summary: 'Update a VPN mesh',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/PatchVpnRequest' } },
        },
      },
      responses: {
        '200': {
          description: 'Updated',
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
        '400': { description: 'Invalid request', content: { 'application/json': { schema: errorBody } } },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: errorBody } } },
      },
    },
    delete: {
      tags: ['VPNs'],
      summary: 'Delete a VPN mesh',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Deleted',
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
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: errorBody } } },
      },
    },
  },
  '/api/client/v1/vpns/{id}/peers': {
    get: {
      tags: ['VPNs'],
      summary: 'List VPN peers',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Peers (presharedKey never returned)',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PeersResponse' } } },
        },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: errorBody } } },
      },
    },
    post: {
      tags: ['VPNs'],
      summary: 'Add a VPN peer',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CreatePeerRequest' } },
        },
      },
      responses: {
        '200': {
          description: 'Created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'id'],
                properties: {
                  ok: { type: 'boolean', const: true },
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        '400': { description: 'Invalid request', content: { 'application/json': { schema: errorBody } } },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: errorBody } } },
        '409': { description: 'Conflict', content: { 'application/json': { schema: errorBody } } },
        '503': { description: 'Encryption unavailable', content: { 'application/json': { schema: errorBody } } },
      },
    },
  },
  '/api/client/v1/vpns/{id}/peers/{peerId}': {
    patch: {
      tags: ['VPNs'],
      summary: 'Update a VPN peer',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'peerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/PatchPeerRequest' } },
        },
      },
      responses: {
        '200': {
          description: 'Updated',
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
        '400': { description: 'Invalid request', content: { 'application/json': { schema: errorBody } } },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: errorBody } } },
        '409': { description: 'Conflict', content: { 'application/json': { schema: errorBody } } },
      },
    },
    delete: {
      tags: ['VPNs'],
      summary: 'Delete a VPN peer',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'peerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Deleted',
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
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: errorBody } } },
      },
    },
  },
  '/api/client/v1/vpns/{id}/apply': {
    post: {
      tags: ['VPNs'],
      summary: 'Apply WireGuard mesh configuration to all peer servers',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Per-peer command enqueue results',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/WireguardApplyResponse' },
            },
          },
        },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorBody } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: errorBody } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: errorBody } } },
        '422': { description: 'Prepare error', content: { 'application/json': { schema: errorBody } } },
        '503': { description: 'Unavailable', content: { 'application/json': { schema: errorBody } } },
      },
    },
  },
}
