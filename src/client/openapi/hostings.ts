import { buildResourceCrudPaths } from './shared.ts'

export const hostingSchemas = {
  HostingRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      organizationId: { type: 'string' },
      projectId: { type: 'string' },
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
    required: ['projectId'],
    properties: {
      displayName: { type: 'string' },
      projectId: { type: 'string' },
    },
  },
}

export const hostingPaths = buildResourceCrudPaths({
  plural: 'hostings',
  singular: 'hosting',
  listSchema: 'HostingsResponse',
  rowSchema: 'HostingRow',
  createSchema: 'CreateHostingRequest',
  parentQuery: {
    name: 'projectId',
    description: 'Filter hostings under a project',
  },
})
