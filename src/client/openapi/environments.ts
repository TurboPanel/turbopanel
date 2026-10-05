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
  ConfigViewChange: {
    type: 'object',
    required: [
      'key',
      'area',
      'label',
      'field',
      'serviceName',
      'serviceId',
      'kind',
      'baseValue',
      'baseSource',
      'envValue',
      'envSource',
      'masked',
    ],
    properties: {
      key: {
        type: 'string',
        description:
          'Stable id: `svc:<service>` (a whole service), `svc:<service>:<field>`, `user:<name>` or `var:<NAME>`.',
      },
      area: { type: 'string', enum: ['service', 'domain', 'linuxUser', 'variable'] },
      label: { type: 'string', description: 'Plain-words name of what changed.' },
      field: {
        type: ['string', 'null'],
        description: 'Field inside the service; null for a whole service, or a variable.',
      },
      serviceName: { type: ['string', 'null'] },
      serviceId: {
        type: ['string', 'null'],
        description: "This environment's service row; null when none is saved yet.",
      },
      kind: { type: 'string', enum: ['added', 'changed', 'removed'] },
      baseValue: {
        type: ['string', 'null'],
        description: 'What the Base has; null when it has nothing, or when masked.',
      },
      baseSource: {
        type: ['string', 'null'],
        enum: ['base', 'project', null],
        description:
          '`base` for compose, `project` for a project variable; null when the Base has nothing.',
      },
      envValue: {
        type: ['string', 'null'],
        description: 'What this environment has; null when it has nothing, or when masked.',
      },
      envSource: { type: ['string', 'null'], enum: ['environment', null] },
      masked: {
        type: 'boolean',
        description: 'True when a side is a secret: the change is real but no value is sent.',
      },
    },
  },
  ConfigViewFieldRow: {
    type: 'object',
    required: ['key', 'area', 'field', 'label', 'value', 'masked', 'source'],
    properties: {
      key: { type: 'string' },
      area: { type: 'string', enum: ['service', 'domain', 'linuxUser'] },
      field: { type: 'string' },
      label: { type: 'string' },
      value: { type: ['string', 'null'], description: 'Null when masked.' },
      masked: { type: 'boolean' },
      source: { type: 'string', enum: ['base', 'environment'] },
    },
  },
  ConfigViewService: {
    type: 'object',
    required: ['name', 'serviceId', 'kind', 'source', 'rows'],
    properties: {
      name: { type: 'string' },
      serviceId: { type: ['string', 'null'] },
      kind: { type: 'string', enum: ['container', 'site', 'node'] },
      source: {
        type: 'string',
        enum: ['base', 'environment'],
        description: '`environment` when added here, or when the environment stands alone.',
      },
      rows: { type: 'array', items: { $ref: '#/components/schemas/ConfigViewFieldRow' } },
    },
  },
  ConfigViewLinuxUser: {
    type: 'object',
    required: ['name', 'access', 'description', 'source', 'usedBy'],
    properties: {
      name: { type: 'string' },
      access: { type: 'string', enum: ['none', 'sftp', 'ssh'] },
      description: { type: ['string', 'null'] },
      source: { type: 'string', enum: ['base', 'environment'] },
      usedBy: { type: 'array', items: { type: 'string' }, description: 'Service names.' },
    },
  },
  ConfigViewVariable: {
    type: 'object',
    required: [
      'key',
      'name',
      'variableId',
      'value',
      'isSecret',
      'forBuild',
      'forRuntime',
      'source',
    ],
    properties: {
      key: { type: 'string', description: '`var:<NAME>`' },
      name: { type: 'string' },
      variableId: { type: 'string', format: 'uuid' },
      value: { type: ['string', 'null'], description: 'Null when secret.' },
      isSecret: { type: 'boolean' },
      forBuild: { type: 'boolean' },
      forRuntime: { type: 'boolean' },
      source: { type: 'string', enum: ['project', 'environment'] },
    },
  },
  ConfigViewSide: {
    type: 'object',
    required: ['services', 'variables', 'linuxUsers'],
    properties: {
      services: { type: 'array', items: { $ref: '#/components/schemas/ConfigViewService' } },
      variables: { type: 'array', items: { $ref: '#/components/schemas/ConfigViewVariable' } },
      linuxUsers: { type: 'array', items: { $ref: '#/components/schemas/ConfigViewLinuxUser' } },
    },
  },
  EnvironmentConfigViewResponse: {
    type: 'object',
    required: ['ok', 'environmentId', 'projectId', 'followsBase', 'base', 'effective', 'changes'],
    properties: {
      ok: { type: 'boolean', const: true },
      environmentId: { type: 'string', format: 'uuid' },
      projectId: { type: 'string', format: 'uuid' },
      followsBase: {
        type: 'boolean',
        description:
          'Derived from the saved compose files, never stored: false when the environment compose (or one of its extra layers) sets `services: !override` or `services: !reset`, true otherwise.',
      },
      base: { $ref: '#/components/schemas/ConfigViewSide' },
      effective: { $ref: '#/components/schemas/ConfigViewSide' },
      changes: { type: 'array', items: { $ref: '#/components/schemas/ConfigViewChange' } },
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

const environmentCrudPaths = buildResourceCrudPaths({
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
  detailExtraProperties: {
    needsRedeploy: {
      type: 'array',
      items: {
        type: 'object',
        required: ['serverId', 'environmentId'],
        properties: {
          serverId: { type: 'string', format: 'uuid' },
          environmentId: { type: 'string', format: 'uuid' },
        },
      },
      description:
        'Deploy targets whose running hosting `bindAddress` predates an automatic repin of the membership pin their `hosting.ipId` names (`ip.metadata.repin.at` later than the last applied `deployment.finishedAt`). Derived, read-only; nothing enqueues environment.deploy.',
    },
  },
})

export const environmentPaths = {
  ...environmentCrudPaths,
  '/api/client/v1/environments/{id}/config-view': {
    get: {
      tags: ['Environments'],
      summary: 'What this environment really runs, and what it changes from the Base',
      description:
        "Read-only and derived from saved data; nothing is stored and no deploy preparation runs. `effective` is the project's Base compose merged with the environment's own compose by the same merge a deploy uses (services, domains, Linux users) plus the project and environment variables (environment wins by name). `base` is the Base alone. `changes` lists what the environment does differently, per service and field, with where each value comes from. Secret variables and credential-looking compose values are never sent: the row says `masked` and carries no value. Organization and workspace variables, and root networks and volumes, are not part of this view.",
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Configuration view',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EnvironmentConfigViewResponse' },
            },
          },
        },
        403: { description: 'Requires organization manage access' },
        404: { description: 'Environment not found in this organization' },
        422: {
          description:
            '`compose_invalid`: a saved compose file for the project or environment cannot be read',
        },
      },
    },
  },
}
