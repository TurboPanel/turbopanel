import { clientErrorJson } from './shared.ts'

const linkSchema = {
  type: 'string',
  enum: ['up', 'down', 'unknown'],
  description:
    'Link state the daemon read from the kernel for the NIC. `unknown` when the daemon did not say (older daemon, unreadable sysfs); routing treats unknown as up.',
}

const purposeSchema = {
  type: 'string',
  enum: ['failover-replication', 'read-replication', 'client-backend'],
}

export const serverTrafficMapSchemas = {
  ServerTrafficMapNetwork: {
    type: 'object',
    description:
      'One datacenter network two servers share, in the order routing tries them: networks that are up by priority, then networks that are down, then untrusted ones.',
    required: [
      'datacenterId',
      'name',
      'priority',
      'trusted',
      'state',
      'localAddress',
      'peerAddress',
      'localInterface',
      'peerInterface',
      'localLink',
      'peerLink',
    ],
    properties: {
      datacenterId: { type: 'string', format: 'uuid' },
      name: { type: ['string', 'null'] },
      priority: {
        type: 'integer',
        minimum: 0,
        maximum: 1000,
        description: 'Lower number wins; default 100.',
      },
      trusted: { type: 'boolean' },
      state: {
        type: 'string',
        enum: ['chosen', 'standby', 'link_down', 'untrusted'],
        description:
          '`chosen` carries server-to-server traffic for this pair (best priority among networks that are up on both servers). `standby` is up but not chosen; it takes over if the chosen one goes down. `link_down` is trusted but a NIC reports no link; used only as a last resort. `untrusted` is never used.',
      },
      localAddress: { type: ['string', 'null'] },
      peerAddress: { type: ['string', 'null'] },
      localInterface: { type: ['string', 'null'] },
      peerInterface: { type: ['string', 'null'] },
      localLink: linkSchema,
      peerLink: linkSchema,
    },
  },
  ServerTrafficMapTrafficRow: {
    type: 'object',
    description:
      'Where one kind of traffic to this peer is planned. This is a plan: the control plane chooses the address, the operating system chooses the NIC for it. Observed NICs exist only on the TurboFabric row.',
    required: ['purpose', 'planned', 'error', 'onChosenNetwork'],
    properties: {
      purpose: purposeSchema,
      planned: {
        oneOf: [
          {
            type: 'object',
            required: ['transport', 'address', 'datacenterId', 'localInterface', 'linkDown'],
            properties: {
              transport: { type: 'string', enum: ['local', 'datacenter', 'fabric', 'public'] },
              address: { type: 'string' },
              datacenterId: { type: ['string', 'null'], format: 'uuid' },
              localInterface: {
                type: ['string', 'null'],
                description:
                  'Local NIC holding the address on the datacenter network; null when unknown or not a datacenter address.',
              },
              linkDown: {
                type: 'boolean',
                description:
                  'True when this network was used only because no network that is up could carry the traffic.',
              },
            },
          },
          { type: 'null' },
        ],
      },
      error: {
        type: ['string', 'null'],
        description:
          'Set when no path exists: `private_path_unavailable`, `private_family_mismatch`, `failover_requires_trusted_datacenter`, `datacenter_ip_required`.',
      },
      onChosenNetwork: {
        type: 'boolean',
        description:
          'Planned on the chosen network of this pair. False when the traffic rides fabric or public, a network that is down, or when no network is chosen.',
      },
    },
  },
  ServerTrafficMapFabricRow: {
    type: 'object',
    description:
      'The TurboFabric tunnel to this peer: what was planned and what the daemon last observed.',
    required: ['plannedPath', 'plannedEndpoint', 'degraded', 'observed', 'onChosenNetwork'],
    properties: {
      plannedPath: {
        type: ['string', 'null'],
        description:
          '`direct_lan`, `direct_public`, `direct_nat`, `gateway`, `relay` or `unreachable`.',
      },
      plannedEndpoint: { type: ['string', 'null'] },
      degraded: { type: 'boolean' },
      observed: {
        oneOf: [
          {
            type: 'object',
            required: [
              'at',
              'interface',
              'endpoint',
              'lastHandshakeAt',
              'transferRx',
              'transferTx',
            ],
            properties: {
              at: { type: 'string', format: 'date-time' },
              interface: {
                type: ['string', 'null'],
                description:
                  'Local NIC the tunnel uses; null when the tunnel follows the default route (or the daemon is older).',
              },
              endpoint: { type: ['string', 'null'] },
              lastHandshakeAt: { type: ['string', 'null'], format: 'date-time' },
              transferRx: {
                type: ['integer', 'null'],
                description: 'Bytes received from this peer, as `wg show` counts them.',
              },
              transferTx: { type: ['integer', 'null'] },
            },
          },
          { type: 'null' },
        ],
      },
      onChosenNetwork: {
        type: ['boolean', 'null'],
        description: 'Whether the tunnel rides the chosen network; null when it cannot be told.',
      },
    },
  },
  ServerTrafficMapPeer: {
    type: 'object',
    required: ['serverId', 'name', 'chosenDatacenterId', 'sharedNetworks', 'traffic', 'fabric'],
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      name: { type: ['string', 'null'] },
      chosenDatacenterId: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          'Network this pair uses for server-to-server traffic, or null when no shared trusted network is up.',
      },
      sharedNetworks: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServerTrafficMapNetwork' },
      },
      traffic: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServerTrafficMapTrafficRow' },
      },
      fabric: {
        oneOf: [{ $ref: '#/components/schemas/ServerTrafficMapFabricRow' }, { type: 'null' }],
        description: 'Null when either server is not on the organization TurboFabric.',
      },
    },
  },
  ServerTrafficMapNic: {
    type: 'object',
    required: ['name', 'link', 'defaultRoute', 'addresses', 'metrics'],
    properties: {
      name: { type: 'string' },
      link: linkSchema,
      defaultRoute: { type: 'boolean' },
      addresses: {
        type: 'array',
        items: {
          type: 'object',
          required: ['address', 'datacenterId'],
          properties: {
            address: { type: 'string' },
            datacenterId: {
              type: ['string', 'null'],
              format: 'uuid',
              description: 'Datacenter this address is pinned into, if any.',
            },
          },
        },
      },
      metrics: {
        description:
          "Where to read this NIC's byte counters: `GET /servers/{id}/metrics/series` with the network family and this `deviceId`. Counters exist only while `monitored` is true (the monitored NIC set is capped per plan; a NIC that carries a datacenter address is added automatically when a free slot exists). Null when no topology entry is recorded for the NIC.",
        oneOf: [
          {
            type: 'object',
            required: ['deviceId', 'monitored', 'speedMbps'],
            properties: {
              deviceId: { type: 'string' },
              monitored: { type: 'boolean' },
              speedMbps: { type: ['integer', 'null'] },
            },
          },
          { type: 'null' },
        ],
      },
    },
  },
  ServerTrafficMap: {
    type: 'object',
    required: ['ok', 'generatedAt', 'serverId', 'nics', 'peers'],
    properties: {
      ok: { type: 'boolean', const: true },
      generatedAt: { type: 'string', format: 'date-time' },
      serverId: { type: 'string', format: 'uuid' },
      nics: { type: 'array', items: { $ref: '#/components/schemas/ServerTrafficMapNic' } },
      peers: { type: 'array', items: { $ref: '#/components/schemas/ServerTrafficMapPeer' } },
    },
  },
}

export const serverTrafficMapPaths: Record<string, unknown> = {
  '/api/client/v1/servers/{id}/traffic-map': {
    get: {
      tags: ['Servers'],
      summary: 'Server-to-server traffic map',
      description:
        'For each peer this server can reach privately: the shared networks, the one chosen by priority (lowest number among trusted networks whose link is up on both servers; a network with its link down is a last resort), where each kind of traffic is planned, and, for the TurboFabric tunnel, the NIC the daemon observed. Read-only: nothing is probed. Peers are limited to servers the viewer may read.',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Traffic map',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ServerTrafficMap' } },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '403': {
          description: 'Forbidden',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '404': {
          description: 'Not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '503': {
          description: 'Database unavailable',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
}
