import { buildResourceCrudPaths } from './shared.ts'

export const projectSchemas = {
  ProjectRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      workspaceId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ProjectsResponse: {
    type: 'object',
    required: ['projects'],
    properties: {
      projects: {
        type: 'array',
        items: { $ref: '#/components/schemas/ProjectRow' },
      },
    },
  },
  CreateProjectRequest: {
    type: 'object',
    required: ['workspaceId'],
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      workspaceId: { type: 'string' },
    },
  },
}

export const projectPaths = buildResourceCrudPaths({
  plural: 'projects',
  singular: 'project',
  tag: 'Projects',
  listSchema: 'ProjectsResponse',
  rowSchema: 'ProjectRow',
  createSchema: 'CreateProjectRequest',
  parentQuery: {
    name: 'workspaceId',
    description: 'Filter projects under a workspace',
  },
})
