import { buildResourceCrudPaths } from './shared.ts'

export const projectSchemas = {
  ProjectRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      organizationId: { type: 'string' },
      environmentId: { type: 'string' },
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
    required: ['environmentId'],
    properties: {
      displayName: { type: 'string' },
      environmentId: { type: 'string' },
    },
  },
}

export const projectPaths = buildResourceCrudPaths({
  plural: 'projects',
  singular: 'project',
  listSchema: 'ProjectsResponse',
  rowSchema: 'ProjectRow',
  createSchema: 'CreateProjectRequest',
  parentQuery: {
    name: 'environmentId',
    description: 'Filter projects under an environment',
  },
})
