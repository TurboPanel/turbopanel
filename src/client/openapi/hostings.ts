import { buildResourceCrudPaths } from './shared.ts'

export const hostingSchemas = {
  HostingOptions: {
    type: 'object',
    properties: {
      hostnames: { type: 'array', items: { type: 'string' } },
      pathPrefix: { type: 'string' },
      targetPort: { type: 'number' },
      bind: {
        type: 'string',
        enum: ['public', 'datacenter', 'local'],
        description: 'Ingress bind scope for this hosting',
      },
      proxy: {
        type: 'object',
        properties: {
          forceHttps: { type: 'boolean' },
          gzip: { type: 'boolean' },
          brotli: { type: 'boolean' },
          stripPrefix: { type: 'string' },
        },
      },
    },
  },
  HostingRow: {
    type: 'object',
    required: ['id', 'serviceId', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      serviceId: { type: 'string' },
      tlsId: {
        type: ['string', 'null'],
        description: 'Pinned org TLS certificate id; null = basic self-signed (Caddy tls internal)',
      },
      ipId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'Pinned org IP address id for ingress binding',
      },
      metadata: { type: 'object', nullable: true },
      options: {
        oneOf: [
          { $ref: '#/components/schemas/HostingOptions' },
          { type: 'null' },
        ],
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  HostingsResponse: {
    type: 'object',
    required: ['hostings'],
    properties: {
      hostings: {
        type: 'array',
        items: { $ref: '#/components/schemas/HostingRow' },
      },
    },
  },
  CreateHostingRequest: {
    type: 'object',
    required: ['serviceId'],
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      serviceId: { type: 'string' },
      tlsId: { type: ['string', 'null'], format: 'uuid' },
      ipId: { type: ['string', 'null'], format: 'uuid' },
      metadata: { type: 'object' },
      options: { $ref: '#/components/schemas/HostingOptions' },
    },
  },
  UpdateHostingRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      tlsId: { type: ['string', 'null'], format: 'uuid' },
      ipId: { type: ['string', 'null'], format: 'uuid' },
      metadata: { type: 'object' },
      options: { $ref: '#/components/schemas/HostingOptions' },
    },
  },
}

export const hostingPaths = buildResourceCrudPaths({
  plural: 'hostings',
  singular: 'hosting',
  tag: 'Hostings',
  listSchema: 'HostingsResponse',
  rowSchema: 'HostingRow',
  createSchema: 'CreateHostingRequest',
  patchSchema: 'UpdateHostingRequest',
  parentQuery: {
    name: 'serviceId',
    description: 'Filter hostings linked to a service',
  },
})
