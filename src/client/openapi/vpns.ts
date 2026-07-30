import { clientErrorJson } from './shared.ts'

export const vpnSchemas = {
  VpnRow: {
    type: 'object',
    required: ['id', 'organizationId', 'cidr', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      organizationId: { type: 'string', format: 'uuid' },
      cidr: {
        type: 'string',
        description: 'Mesh overlay CIDR; every peer interface address is allocated from this prefix.',
      },
      displayName: { type: ['string', 'null'] },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  PeerRow: {
    type: 'object',
    required: [
      'id',
      'vpnId',
      'serverId',
      'role',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      vpnId: { type: 'string', format: 'uuid' },
      serverId: { type: 'string', format: 'uuid' },
      endpointIpId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'Optional public/endpoint IP row used as the WireGuard endpoint.',
      },
      tunnelIpId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'Overlay `ip` row (scope=vpn) for this peer interface address.',
      },
      role: {
        type: 'string',
        enum: ['gateway', 'member'],
        description: 'Gateway peers advertise their datacenter site routes; members do not.',
      },
      publicKey: {
        type: ['string', 'null'],
        description:
          'Daemon-reported WireGuard public key. Null until the first successful Apply reconciles the host keypair.',
      },
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
    required: ['cidr'],
    properties: {
      displayName: { type: 'string' },
      cidr: {
        type: 'string',
        description: 'Mesh overlay CIDR for peer interface addresses.',
      },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
  PatchVpnRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      cidr: {
        type: 'string',
        description: 'Optional non-null mesh overlay CIDR replacement.',
      },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
    },
  },
  CreatePeerRequest: {
    type: 'object',
    required: ['serverId'],
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      publicKey: {
        type: 'string',
        description:
          'Optional. Omit so the daemon generates the keypair on Apply; reconciled onto the peer row afterward.',
      },
      role: { type: 'string', enum: ['gateway', 'member'] },
      endpointIpId: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          'Optional public `ip` row used as the WireGuard endpoint. When omitted, the server’s oldest public IP is selected automatically (null when the server has none).',
      },
      tunnelIpId: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          'Existing overlay `ip` row (scope=vpn). Mutually exclusive with tunnelAddress. When both tunnelIpId and tunnelAddress are omitted, an address is auto-allocated from vpn.cidr.',
      },
      tunnelAddress: {
        type: 'string',
        description:
          'Explicit overlay address to allocate under vpn.cidr. Mutually exclusive with tunnelIpId. When both tunnelIpId and tunnelAddress are omitted, an address is auto-allocated from vpn.cidr.',
      },
      listenPort: {
        type: 'integer',
        description: 'Optional UDP listen port. Defaults to 51820 when omitted.',
      },
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
      endpointIpId: { type: ['string', 'null'], format: 'uuid' },
      tunnelIpId: { type: ['string', 'null'], format: 'uuid' },
      role: { type: 'string', enum: ['gateway', 'member'] },
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
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
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
                },
              },
            },
          },
        },
        '400': { description: 'Invalid request', content: { 'application/json': { schema: clientErrorJson } } },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
        '409': {
          description: 'Conflict — `vpn_cidr_in_use` when another mesh already uses that CIDR.',
          content: { 'application/json': { schema: clientErrorJson } },
        },
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
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: clientErrorJson } } },
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
        '400': { description: 'Invalid request', content: { 'application/json': { schema: clientErrorJson } } },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: clientErrorJson } } },
        '409': {
          description: 'Conflict — `vpn_cidr_in_use` when another mesh already uses that CIDR.',
          content: { 'application/json': { schema: clientErrorJson } },
        },
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
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: clientErrorJson } } },
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
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: clientErrorJson } } },
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
        '400': { description: 'Invalid request', content: { 'application/json': { schema: clientErrorJson } } },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: clientErrorJson } } },
        '409': {
          description:
            'Conflict — one of `peer_server_conflict`, `peer_public_key_conflict`, `peer_tunnel_ip_conflict`, `vpn_address_conflict`, `vpn_address_pool_exhausted`.',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '503': { description: 'Encryption unavailable', content: { 'application/json': { schema: clientErrorJson } } },
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
        '400': { description: 'Invalid request', content: { 'application/json': { schema: clientErrorJson } } },
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: clientErrorJson } } },
        '409': {
          description:
            'Conflict — one of `peer_server_conflict`, `peer_public_key_conflict`, `peer_tunnel_ip_conflict`, `vpn_address_conflict`, `vpn_address_pool_exhausted`.',
          content: { 'application/json': { schema: clientErrorJson } },
        },
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
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: clientErrorJson } } },
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
        '401': { description: 'Unauthorized', content: { 'application/json': { schema: clientErrorJson } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: clientErrorJson } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: clientErrorJson } } },
        '422': {
          description:
            'Prepare error — one of `vpn_has_no_peers`, `peer_tunnel_address_required`, `daemon_key_unavailable`, `gateway_datacenter_required`, `gateway_datacenter_cidr_required`.',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '503': { description: 'Unavailable', content: { 'application/json': { schema: clientErrorJson } } },
      },
    },
  },
}
