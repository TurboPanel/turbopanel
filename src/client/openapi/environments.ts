import { buildResourceCrudPaths } from './shared.ts'

export const environmentSchemas = {
  EnvironmentRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      projectId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  EnvironmentsResponse: {
    type: 'object',
    required: ['environments'],
    properties: {
      environments: {
        type: 'array',
        items: { $ref: '#/components/schemas/EnvironmentRow' },
      },
    },
  },
  CreateEnvironmentRequest: {
    type: 'object',
    required: ['projectId'],
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      projectId: { type: 'string' },
    },
  },
}

export const environmentPaths = buildResourceCrudPaths({
  plural: 'environments',
  singular: 'environment',
  tag: 'Environments',
  listSchema: 'EnvironmentsResponse',
  rowSchema: 'EnvironmentRow',
  createSchema: 'CreateEnvironmentRequest',
  parentQuery: {
    name: 'projectId',
    description: 'Filter environments under a project',
  },
})
