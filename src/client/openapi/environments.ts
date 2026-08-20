import { buildResourceCrudPaths } from './shared.ts'

export const environmentSchemas = {
  EnvironmentRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      projectId: { type: 'string' },
      serverId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'Placement pin source of truth (environment.server_id).',
      },
      metadata: {
        type: 'object',
        nullable: true,
        description: 'Environment metadata.',
      },
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
      name: { type: 'string' },
      description: { type: 'string' },
      projectId: { type: 'string' },
      serverId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'Placement pin source of truth.',
      },
      metadata: {
        type: 'object',
        nullable: true,
        description: 'Environment metadata.',
      },
      options: {
        type: 'object',
        description: 'Environment options; options.compose holds the per-environment overlay',
      },
    },
  },
  UpdateEnvironmentRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      serverId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'Placement pin source of truth.',
      },
      metadata: {
        type: 'object',
        nullable: true,
        description: 'Environment metadata.',
      },
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
