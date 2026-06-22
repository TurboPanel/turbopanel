import { buildResourceCrudPaths } from './shared.ts'

export const serviceSchemas = {
  ServiceRow: {
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
  ServicesResponse: {
    type: 'object',
    required: ['services'],
    properties: {
      services: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServiceRow' },
      },
    },
  },
  CreateServiceRequest: {
    type: 'object',
    required: ['projectId'],
    properties: {
      displayName: { type: 'string' },
      projectId: { type: 'string' },
    },
  },
}

export const servicePaths = buildResourceCrudPaths({
  plural: 'services',
  singular: 'service',
  listSchema: 'ServicesResponse',
  rowSchema: 'ServiceRow',
  createSchema: 'CreateServiceRequest',
  parentQuery: {
    name: 'projectId',
    description: 'Filter services under a project',
  },
})
