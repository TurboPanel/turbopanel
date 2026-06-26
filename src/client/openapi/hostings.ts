import { buildResourceCrudPaths } from './shared.ts'

export const hostingSchemas = {
  HostingRow: {
    type: 'object',
    required: ['id', 'serviceId', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      serviceId: { type: 'string' },
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
  parentQuery: {
    name: 'serviceId',
    description: 'Filter hostings linked to a service',
  },
})
