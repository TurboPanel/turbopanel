import { clientErrorJson } from './shared.ts'

export const networkSchemas = {
  NetworkRow: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      organizationId: { type: 'string', format: 'uuid' },
      datacenterId: { type: ['string', 'null'], format: 'uuid' },
      serverId: { type: ['string', 'null'], format: 'uuid' },
      kind: { type: 'string', enum: ['datacenter', 'docker'] },
      cidr: { type: ['string', 'null'] },
      displayName: { type: ['string', 'null'] },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
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
  NetworkResponse: {
    type: 'object',
    required: ['network'],
    properties: {
      network: { $ref: '#/components/schemas/NetworkRow' },
    },
  },
  DockerNetworkOptions: {
    type: 'object',
    required: ['dockerNetworkName'],
    properties: {
      dockerNetworkName: {
        type: 'string',
        description:
          'Host Docker network name matching compose networks.*.external name (or mapping key). Required when kind is docker.',
        pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
      },
    },
    additionalProperties: true,
  },
  CreateNetworkRequest: {
    type: 'object',
    required: ['organizationId', 'kind'],
    properties: {
      organizationId: { type: 'string', format: 'uuid' },
      kind: {
        type: 'string',
        enum: ['datacenter', 'docker'],
        description:
          'Scope pairing: datacenter requires datacenterId (no serverId); docker may optionally pin serverId for a host-local external network and must not set datacenterId (network_scope_required / network_single_scope_conflict on 400).',
      },
      datacenterId: { type: ['string', 'null'], format: 'uuid' },
      serverId: { type: ['string', 'null'], format: 'uuid' },
      cidr: { type: 'string' },
      displayName: { type: 'string' },
      metadata: { type: 'object' },
      options: {
        description:
          'For kind=docker, must include dockerNetworkName (long-lived external Docker network).',
        oneOf: [
          { $ref: '#/components/schemas/DockerNetworkOptions' },
          { type: 'object' },
        ],
      },
    },
  },
  PatchNetworkRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      cidr: { type: ['string', 'null'] },
      metadata: { type: ['object', 'null'] },
      options: {
        description:
          'When patching a kind=docker network, options must include a valid dockerNetworkName.',
        oneOf: [
          { $ref: '#/components/schemas/DockerNetworkOptions' },
          { type: 'object' },
          { type: 'null' },
        ],
      },
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
      summary: 'List networks',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'organizationId',
          in: 'query',
          description: 'Active organization (also accepted via X-Turbopanel-Organization-Id header)',
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'datacenterId',
          in: 'query',
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'serverId',
          in: 'query',
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'kind',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['datacenter', 'docker'],
          },
        },
      ],
      responses: {
        '200': {
          description: 'Networks in the session organization',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NetworksResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid filter',
          content: { 'application/json': { schema: clientErrorJson } },
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
          description: 'Filter target not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
    post: {
      tags: ['Networks'],
      summary: 'Create a network',
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
          description:
            'Invalid request — `docker_network_name_required` when kind=docker; `network_scope_required` when datacenter lacks datacenterId; `network_single_scope_conflict` when both scope ids are set, datacenter carries serverId, or docker carries datacenterId.',
          content: { 'application/json': { schema: clientErrorJson } },
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
          description: 'Scope entity not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
  '/api/client/v1/networks/{id}': {
    get: {
      tags: ['Networks'],
      summary: 'Get a network',
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
          description: 'Network',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NetworkResponse' },
            },
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
          description: 'Network not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
    patch: {
      tags: ['Networks'],
      summary: 'Update a network',
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
            schema: { $ref: '#/components/schemas/PatchNetworkRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Network updated',
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
        '400': {
          description: 'Invalid request',
          content: { 'application/json': { schema: clientErrorJson } },
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
          description: 'Network not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
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
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '403': {
          description: 'Forbidden',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '404': {
          description: 'Network not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
}
