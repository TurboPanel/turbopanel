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
      isPrimary: {
        type: 'boolean',
        description:
          "True for the project's one primary environment: the landing, the status and the source a new environment copies. Set on the first environment; change it with `POST /environments/{id}/primary`.",
      },
      pinned: {
        type: 'boolean',
        description:
          'Pinned environments are listed right after the primary one. Change it with PATCH `pinned`.',
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
    required: ['key', 'area', 'field', 'label', 'value', 'masked', 'source', 'inheritedFromBase'],
    properties: {
      key: { type: 'string' },
      area: { type: 'string', enum: ['service', 'domain', 'linuxUser'] },
      field: { type: 'string' },
      label: { type: 'string' },
      value: { type: ['string', 'null'], description: 'Null when masked.' },
      masked: { type: 'boolean' },
      source: { type: 'string', enum: ['base', 'environment'] },
      inheritedFromBase: {
        type: 'boolean',
        description:
          'True when the value comes from the Base; false when this environment sets or overrides it.',
      },
    },
  },
  ConfigViewService: {
    type: 'object',
    required: ['name', 'serviceId', 'kind', 'source', 'inheritedFromBase', 'rows'],
    properties: {
      name: { type: 'string' },
      serviceId: { type: ['string', 'null'] },
      kind: { type: 'string', enum: ['container', 'site', 'node'] },
      source: {
        type: 'string',
        enum: ['base', 'environment'],
        description: '`environment` when added here, or when the environment stands alone.',
      },
      inheritedFromBase: {
        type: 'boolean',
        description: 'True when the service is defined in the Base.',
      },
      rows: { type: 'array', items: { $ref: '#/components/schemas/ConfigViewFieldRow' } },
    },
  },
  ConfigViewLinuxUser: {
    type: 'object',
    required: ['name', 'access', 'description', 'source', 'inheritedFromBase', 'usedBy'],
    properties: {
      name: { type: 'string' },
      access: { type: 'string', enum: ['none', 'sftp', 'ssh'] },
      description: { type: ['string', 'null'] },
      source: { type: 'string', enum: ['base', 'environment'] },
      inheritedFromBase: {
        type: 'boolean',
        description: 'True when the Linux user is defined in the Base.',
      },
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
      'inheritedFromBase',
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
      inheritedFromBase: {
        type: 'boolean',
        description: 'True for a project-level variable this environment does not override.',
      },
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
    required: [
      'ok',
      'environmentId',
      'projectId',
      'isPrimary',
      'standsAlone',
      'base',
      'effective',
      'changes',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      environmentId: { type: 'string', format: 'uuid' },
      projectId: { type: 'string', format: 'uuid' },
      isPrimary: {
        type: 'boolean',
        description: "True when this is the project's primary environment.",
      },
      standsAlone: {
        type: 'boolean',
        description:
          'Derived from the saved compose files, never stored: true when the environment compose (or one of its extra layers) sets `services: !override` or `services: !reset`, so it drops the Base services. Every environment otherwise inherits from the Base; each row says so with `inheritedFromBase`.',
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
      name: {
        type: 'string',
        description:
          'Unique within the project: **409** `environment_name_in_use` when another environment of the project has it.',
      },
      description: { type: 'string' },
      projectId: { type: 'string' },
      start: {
        type: 'string',
        enum: ['copy', 'empty'],
        description:
          "How the environment starts when `options` is not sent. `copy` (the default) copies the primary environment's services and settings (its own compose changes and extra layers); it still inherits the Base like every environment. A copy does NOT take what must be unique per environment: domains and routes, published host ports (the container's own ports stay, as `expose`), fixed `container_name`s, and the git branch (the source is kept but `deployOnPush` is set to false, so a push never deploys the copy until a branch is chosen and push deploys are turned on). What the Base still gives the environment (a hostname, published ports, a container name, an auto-deploying source) is overridden in the copy's own layer with the compose `!reset` / `!override` rules (a branch inherited from the Base is kept, with push deploys off). Variables, secrets and the server pin are never copied. The copy is read again under the project lock: **409** `primary_environment_conflict` if the primary changed meanwhile. The create response lists what was left out in `notCopied`, in plain words. `empty` stands alone: it drops the Base's services (`services: !override {}`) and starts with nothing. The first environment of a project becomes its primary one. **400** `environment_start_invalid` for another value, **400** `environment_start_conflict` when `options` is also sent. The name follows the environment name rule on every path: **400** `invalid_environment_name`.",
      },
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
      pinned: {
        type: 'boolean',
        description:
          'Pin or unpin the environment. A pin-only change is never refused by the folder or deploy locks.',
      },
      name: {
        type: 'string',
        description:
          'Unique within the project: **409** `environment_name_in_use` when another environment of the project has it.',
      },
      description: { type: 'string' },
      serverId: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          'Placement pin source of truth. Moving to another server is refused while the environment has folders: **409** `environment_server_locked` (the body lists them like `environment_name_locked`).',
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
  EnvironmentShare: {
    type: 'object',
    required: ['id', 'environmentId', 'kind', 'assetId'],
    description:
      'An environment using a common service or volume of a site owner. Deleting the environment removes it; the asset cannot be deleted while another environment uses it (**409** `common_asset_in_use`, with the environments in `uses`).',
    properties: {
      id: { type: 'string', format: 'uuid' },
      environmentId: { type: 'string', format: 'uuid' },
      environmentName: { type: ['string', 'null'] },
      projectId: { type: 'string', format: 'uuid' },
      projectName: { type: ['string', 'null'] },
      kind: { type: 'string', enum: ['service', 'volume'] },
      assetId: { type: 'string', format: 'uuid' },
      assetName: { type: ['string', 'null'] },
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
  '/api/client/v1/environments/{id}/folders': {
    get: {
      tags: ['Environments'],
      summary: 'Service and volume folders under this environment',
      description:
        "The folders that exist under the environment's name on any server (planned, present, removing, orphan; not missing). While any exists the environment cannot be renamed or deleted: PATCH and DELETE answer 409 environment_name_locked or environment_has_folders with this same list. A removing folder is one the host has not confirmed deleted yet, for example because the server is offline. `total` counts all of them; `folders` lists the first 20, oldest first. Assets in the shared (common) scope belong to no environment and are not listed.",
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Folders under the environment',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'folders', 'total'],
                properties: {
                  ok: { type: 'boolean' },
                  total: { type: 'integer' },
                  folders: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'kind', 'state', 'scope', 'slug', 'serverId'],
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        kind: { type: 'string', enum: ['service', 'volume'] },
                        state: {
                          type: 'string',
                          enum: ['planned', 'present', 'removing', 'orphan', 'missing'],
                        },
                        scope: { type: 'string' },
                        slug: { type: 'string' },
                        serverId: { type: 'string', format: 'uuid' },
                        serverName: { type: 'string', nullable: true },
                        assetId: { type: 'string', format: 'uuid', nullable: true },
                        assetName: { type: 'string', nullable: true },
                        reason: {
                          type: 'string',
                          nullable: true,
                          description:
                            "Plain words for a removing or orphan folder, such as 'being removed, waiting for server Beta to come back'; null for any other state.",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        403: { description: 'Requires read access to the environment' },
        404: { description: 'Environment not found in this organization' },
      },
    },
  },
  '/api/client/v1/environments/{id}/shares': {
    get: {
      tags: ['Environments'],
      summary: 'Common services and volumes this environment uses',
      description:
        "A common service or volume belongs to a site owner (a Linux user on a server) and lives in that owner's shared `common` folder, so environments of any project in the organization can use it. This lists what this environment uses; the environment that owns the asset is not listed for it.",
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Common assets in use',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'shares'],
                properties: {
                  ok: { type: 'boolean' },
                  shares: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/EnvironmentShare' },
                  },
                },
              },
            },
          },
        },
        403: { description: 'Requires read access to the environment' },
        404: { description: 'Environment not found in this organization' },
      },
    },
    post: {
      tags: ['Environments'],
      summary: 'Start using a common service or volume',
      description:
        'Send exactly one of `serviceId` and `storageId`. Idempotent: using the same asset again returns the same id. **409** `asset_not_common` (only shared assets can be used by other environments), `asset_in_this_environment` (it belongs to this environment already) or `asset_has_no_owner` (a shared asset belongs to a site owner).',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                serviceId: { type: 'string', format: 'uuid' },
                storageId: { type: 'string', format: 'uuid' },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Now in use',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'id'],
                properties: { ok: { type: 'boolean' }, id: { type: 'string', format: 'uuid' } },
              },
            },
          },
        },
        400: { description: 'Not exactly one of serviceId and storageId' },
        403: { description: 'Requires organization manage access' },
        404: { description: 'Environment or asset not found in this organization' },
        409: { description: 'The asset cannot be shared (see description)' },
      },
    },
  },
  '/api/client/v1/environments/{id}/shares/{shareId}': {
    delete: {
      tags: ['Environments'],
      summary: 'Stop using a common service or volume',
      description:
        "Removes this environment's use of the asset; the asset and its folder are untouched. Deleting the environment does the same for all of them.",
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'shareId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'No longer in use' },
        403: { description: 'Requires organization manage access' },
        404: { description: 'No such use on this environment' },
      },
    },
  },
  '/api/client/v1/environments/{id}/primary': {
    post: {
      tags: ['Environments'],
      summary: "Make this environment the project's primary one",
      description:
        'A project has exactly one primary environment. This moves the marker here (the previous primary stops being primary in the same transaction). Idempotent. **409** `primary_environment_conflict` when the marker changed at the same time (nothing is changed). Recorded in the audit trail as `environment.primary.set` when it moves. The primary environment is the landing, the status and the source a new environment copies. It cannot be deleted while the project has other environments: **409** `primary_environment_cannot_be_deleted`.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Now primary',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'id', 'projectId'],
                properties: {
                  ok: { type: 'boolean' },
                  id: { type: 'string', format: 'uuid' },
                  projectId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        403: { description: 'Requires organization manage access' },
        404: { description: 'Environment not found in this organization' },
      },
    },
  },
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
