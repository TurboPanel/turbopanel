import { buildResourceCrudPaths } from './shared.ts'

export const projectSchemas = {
  ProjectRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      workspaceId: { type: 'string' },
      metadata: { type: 'object', nullable: true },
      options: {
        type: 'object',
        nullable: true,
        description:
          'Project options; options.compose is a ComposeDocument (versioned YAML presentation + compose data)',
      },
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
      type: { type: 'string', enum: ['docker-compose', 'template', 'managed'] },
      code: { type: 'string', description: 'Catalog code when type is template or managed' },
      metadata: { type: 'object', nullable: true },
      options: {
        type: 'object',
        nullable: true,
        description:
          'Project options; options.compose must be a ComposeDocument (version 1 with data and presentation)',
      },
    },
  },
  UpdateProjectRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      options: {
        type: 'object',
        nullable: true,
        description:
          'Project options; options.compose must be a ComposeDocument (version 1 with data and presentation)',
      },
    },
  },
  ProjectCatalogEntry: {
    type: 'object',
    required: ['code', 'kind', 'displayName', 'description'],
    properties: {
      code: { type: 'string' },
      kind: { type: 'string', enum: ['managed', 'template'] },
      displayName: { type: 'string' },
      description: { type: 'string' },
    },
  },
  ProjectCatalogResponse: {
    type: 'object',
    required: ['catalog'],
    properties: {
      catalog: {
        type: 'array',
        items: { $ref: '#/components/schemas/ProjectCatalogEntry' },
      },
    },
  },
}

export const projectPaths = {
  ...buildResourceCrudPaths({
    plural: 'projects',
    singular: 'project',
    tag: 'Projects',
    listSchema: 'ProjectsResponse',
    rowSchema: 'ProjectRow',
    createSchema: 'CreateProjectRequest',
    patchSchema: 'UpdateProjectRequest',
    parentQuery: {
      name: 'workspaceId',
      description: 'Filter projects under a workspace',
    },
  }),
  '/api/client/v1/project-catalog': {
    get: {
      tags: ['Projects'],
      summary: 'List project catalog entries',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'UI-safe project catalog summaries',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProjectCatalogResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
}
