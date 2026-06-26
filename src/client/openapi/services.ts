import { buildResourceCrudPaths } from './shared.ts'

export const serviceSchemas = {
  ServiceRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      environmentId: { type: 'string' },
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
    required: ['environmentId'],
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      environmentId: { type: 'string' },
    },
  },
}

export const servicePaths = buildResourceCrudPaths({
  plural: 'services',
  singular: 'service',
  tag: 'Services',
  listSchema: 'ServicesResponse',
  rowSchema: 'ServiceRow',
  createSchema: 'CreateServiceRequest',
  parentQuery: {
    name: 'environmentId',
    description: 'Filter services under an environment',
  },
})
