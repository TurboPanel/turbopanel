import { buildResourceCrudPaths } from './shared.ts'

export const environmentSchemas = {
  EnvironmentRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      projectId: { type: 'string' },
      metadata: { type: 'object', nullable: true },
      options: {
        type: 'object',
        nullable: true,
        description: 'Environment options; options.compose holds the per-environment overlay',
      },
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
      metadata: { type: 'object', nullable: true },
      options: {
        type: 'object',
        description: 'Environment options; options.compose holds the per-environment overlay',
      },
    },
  },
  UpdateEnvironmentRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      metadata: { type: 'object', nullable: true },
      options: {
        type: 'object',
        nullable: true,
        description: 'Environment options; options.compose holds the per-environment overlay',
      },
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
  patchSchema: 'UpdateEnvironmentRequest',
  parentQuery: {
    name: 'projectId',
    description: 'Filter environments under a project',
  },
})
