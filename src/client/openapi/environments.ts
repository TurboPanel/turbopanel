import { buildResourceCrudPaths } from './shared.ts'

export const environmentSchemas = {
  EnvironmentRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      organizationId: { type: 'string' },
      workspaceId: { type: 'string' },
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
    required: ['workspaceId'],
    properties: {
      displayName: { type: 'string' },
      workspaceId: { type: 'string' },
    },
  },
}

export const environmentPaths = buildResourceCrudPaths({
  plural: 'environments',
  singular: 'environment',
  listSchema: 'EnvironmentsResponse',
  rowSchema: 'EnvironmentRow',
  createSchema: 'CreateEnvironmentRequest',
  parentQuery: {
    name: 'workspaceId',
    description: 'Filter environments under a workspace',
  },
})
