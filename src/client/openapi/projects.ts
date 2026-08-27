import { buildResourceCrudPaths } from './shared.ts'

export const projectSchemas = {
  ProjectRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      workspaceId: { type: 'string' },
      repositoryId: {
        type: ['string', 'null'],
        description:
          'The one Git repository this project is, or null when it is not repository-backed. Every x-turbopanel.source.sourceId in the project compose must name this row.',
      },
      metadata: {
        type: 'object',
        nullable: true,
        additionalProperties: true,
        properties: {
          type: {
            type: 'string',
            enum: ['docker-compose', 'template', 'managed', 'system'],
            description:
              'Project kind. `system` is platform-owned (TurboPanel workspace projects) and read-only — never accepted on create or configure.',
          },
          code: {
            type: 'string',
            description: 'Catalog code when type is template or managed',
          },
          component: {
            type: 'string',
            description: 'Platform system component key (hosting-ingress, managed-ingress, …)',
          },
        },
      },
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
      name: { type: 'string' },
      description: { type: 'string' },
      workspaceId: { type: 'string' },
      type: {
        type: 'string',
        enum: ['empty', 'docker-compose', 'template', 'managed'],
        description:
          'empty creates an untyped project with Production once; type is chosen later via POST …/configure. Omitting type defaults to docker-compose for compatibility. The platform-only `system` type is never accepted.',
      },
      code: { type: 'string', description: 'Catalog code when type is template or managed' },
      serverId: {
        type: 'string',
        description: 'Optional server pin for the scaffolded Production environment',
      },
      metadata: { type: 'object', nullable: true },
      options: {
        type: 'object',
        nullable: true,
        description:
          'Project options; options.compose must be a ComposeDocument (version 1 with data and presentation)',
      },
    },
  },
  ConfigureProjectRequest: {
    type: 'object',
    required: ['type'],
    properties: {
      type: {
        type: 'string',
        enum: ['docker-compose', 'template', 'managed'],
      },
      code: {
        type: 'string',
        description: 'Required when type is template or managed',
      },
      serverId: {
        type: 'string',
        description: 'Optional server pin applied to Production during configure',
      },
    },
  },
  ConfigureProjectResponse: {
    type: 'object',
    required: ['ok', 'alreadyConfigured'],
    properties: {
      ok: { type: 'boolean', enum: [true] },
      alreadyConfigured: {
        type: 'boolean',
        description: 'True when the same type was already set (idempotent)',
      },
    },
  },
  UpdateProjectRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      workspaceId: {
        type: 'string',
        description: 'Move the project to another workspace in the same organization',
      },
      repositoryId: {
        type: ['string', 'null'],
        description:
          "Re-bind the project to a different repository, or null to unbind. Validated against the compose in the same request: a document naming any other repository is rejected. Omit to keep the current binding — a project with none adopts the first repository its compose names.",
      },
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
  '/api/client/v1/projects/{id}/configure': {
    post: {
      tags: ['Projects'],
      summary: 'Configure type for an empty project',
      description:
        'Sets docker-compose, template, or managed on a project that has not yet chosen a type. Idempotent when already configured with the same type (+ code). Rejects changing type after configuration.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ConfigureProjectRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Type configured (or already matched)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ConfigureProjectResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request',
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
        '403': {
          description: 'Forbidden',
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
        '404': {
          description: 'Not found',
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
        '409': {
          description: 'Project type already configured differently',
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
