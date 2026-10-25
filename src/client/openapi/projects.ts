import { PROJECT_ICONS } from '../../features/projects/vocabulary.ts'
import { buildResourceCrudPaths } from './shared.ts'
import { deleteOperation, deletePreviewPath, withDeleteOperation } from './delete-plan.ts'

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
      kind: {
        type: 'string',
        nullable: true,
        enum: ['compose', 'managed', 'system'],
        description:
          'What the project is. `compose` also covers a template project (which carries metadata.code); `managed` is a managed database or service; `system` is platform-owned and read-only. null while the project is a draft that has not chosen yet; set by create or POST …/configure, never by PATCH.',
      },
      icon: {
        type: 'string',
        nullable: true,
        enum: PROJECT_ICONS,
        description:
          'Icon key from the fixed list the project screens offer; null means the default. A managed project ignores it and always shows the managed icon.',
      },
      metadata: {
        type: 'object',
        nullable: true,
        additionalProperties: true,
        properties: {
          code: {
            type: 'string',
            description: 'Catalog code of a template or managed engine project',
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
      environmentName: {
        type: 'string',
        description:
          "Optional name for the project's first environment. Omitted means the organization default (else Production).",
      },
      metadata: { type: 'object', nullable: true },
      icon: {
        type: 'string',
        nullable: true,
        enum: PROJECT_ICONS,
        description: 'Optional icon key; ignored for managed projects.',
      },
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
      icon: {
        type: 'string',
        nullable: true,
        enum: PROJECT_ICONS,
        description:
          'Icon key from the fixed list, or null for the default. Ignored for managed projects.',
      },
      workspaceId: {
        type: 'string',
        description: 'Move the project to another workspace in the same organization',
      },
      repositoryId: {
        type: ['string', 'null'],
        description:
          'Re-bind the project to a different repository, or null to unbind. Validated against the compose in the same request: a document naming any other repository is rejected. Omit to keep the current binding — a project with none adopts the first repository its compose names.',
      },
      options: {
        type: 'object',
        nullable: true,
        description:
          'Project options; options.compose must be a ComposeDocument (version 1 with data and presentation). `compose` and `composeOverlays` are configuration: they need a `target`.',
      },
      target: {
        type: 'string',
        description:
          "Where an `options.compose` / `options.composeOverlays` edit lands: `base` (the project's own compose, inherited by every environment) or an environment id of the project. With exactly one environment and no target the edit goes to that environment, never the Base. With several and no target: **400** `edit_target_required`. Anything else: **400** `edit_target_invalid`. For an environment target `options` may carry only `compose` and `composeOverlays`: **400** `edit_target_mixed` otherwise (send project settings separately with target `base`). Ignored when the request carries no compose. Compatibility: a project whose Base already holds content (older single-environment projects keep it there) cannot take a compose edit without a target, because layering a full document on top of the Base would double lists such as ports and volumes: that answers **400** `edit_target_required` even with one environment. Send `base` to edit the Base.",
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

const projectCrudPaths = buildResourceCrudPaths({
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
})

export const projectPaths = {
  ...projectCrudPaths,
  '/api/client/v1/projects/{id}': withDeleteOperation(
    projectCrudPaths,
    '/api/client/v1/projects/{id}',
    deleteOperation(
      'Projects',
      'project',
      "Stops every environment's services on their servers, then removes the project's rows in one step: environments, services, hostings (compose-declared ones too), volumes set to be deleted with it. Each folder on a server becomes `removing` and the server is asked to remove it (asked again until it confirms); a volume set to keep its data keeps its folder. The project's Hosting Accounts that nothing else uses are removed (Linux user and home) once their folders are gone; the others are kept and listed. Refused, with nothing changed, while a managed database remains, a shared service or volume is used by another project, or a server the delete has to reach is offline."
    )
  ),
  '/api/client/v1/projects/{id}/delete-preview': deletePreviewPath(
    'Projects',
    'project',
    'What `DELETE /projects/{id}` would remove and keep, and why it would be refused. Reads only.'
  ),
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
