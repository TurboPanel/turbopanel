export const deploySchemas = {
  DeployEnvironmentRequest: {
    type: 'object',
    properties: {
      serverId: {
        type: 'string',
        description: 'Optional override when environment compose has no placement pin',
      },
      acknowledgeHealthCheckWarnings: {
        type: 'boolean',
        description: 'Acknowledge warn-policy health-check gaps before deploy',
      },
      noCache: {
        type: 'boolean',
        description:
          'Cacheless redeploy: rebuild images with `docker compose build --no-cache --pull` before `up`',
      },
    },
  },
  DeployEnvironmentResponse: {
    type: 'object',
    required: ['ok', 'commandId', 'status'],
    properties: {
      ok: { type: 'boolean', const: true },
      commandId: {
        type: 'string',
        description: 'First queued command id (fan-out may enqueue more).',
      },
      status: { type: 'string', const: 'queued' },
      serverId: { type: 'string' },
      commands: {
        type: 'array',
        description: 'Every queued `environment.deploy` (and drained-server stop) command.',
        items: {
          type: 'object',
          required: ['commandId', 'serverId', 'status'],
          properties: {
            commandId: { type: 'string' },
            serverId: { type: 'string' },
            status: { type: 'string', const: 'queued' },
          },
        },
      },
    },
  },
  DeployPreviewWarning: {
    type: 'object',
    required: ['code', 'message'],
    properties: {
      code: {
        type: 'string',
        enum: [
          'empty_compose',
          'resource_limit_exceeded',
          'health_check_missing',
          'docker_external_network_unregistered',
          'traditional_web_principal_ambiguous',
        ],
      },
      message: { type: 'string' },
      details: { type: 'object', additionalProperties: true },
    },
  },
  DeployPreviewComposeFile: {
    type: 'object',
    required: ['filename', 'role', 'content'],
    properties: {
      filename: {
        type: 'string',
        description: 'Basename only (`compose.yaml`) — safe for host paths',
      },
      role: {
        type: 'string',
        enum: ['runtime', 'project', 'environment', 'platform'],
        description:
          'New deploys emit a single `runtime` file. Older queued commands may still carry a project → environment → platform chain.',
      },
      source: {
        type: 'string',
        enum: ['inline', 'repository'],
        description:
          'Provenance of this file (`EnvironmentDeployComposeFile.source`); only `inline` is emitted today.',
      },
      path: {
        type: 'string',
        description:
          'Repo-relative original location when `source` is `repository`. Unused until repository-pinned compose files are supported.',
      },
      content: {
        type: 'string',
        description: 'Compiled runtime compose YAML for this server',
      },
    },
  },
  DeployPreviewResponse: {
    type: 'object',
    required: [
      'ok',
      'composeFiles',
      'projectName',
      'containers',
      'volumes',
      'warnings',
    ],
    properties: {
      ok: { type: 'boolean', const: true },
      composeFiles: {
        type: 'array',
        description:
          'Compiled runtime file the daemon writes as `compose.yaml` (`role: runtime`). Secret values redacted.',
        items: { $ref: '#/components/schemas/DeployPreviewComposeFile' },
      },
      servers: {
        type: 'array',
        description:
          'Per-server compiled snapshots when the scheduler places tasks on more than one host. Omitted or empty for a whole-environment pin / single-server plan.',
        items: {
          type: 'object',
          required: ['serverId', 'name', 'composeFiles', 'services'],
          properties: {
            serverId: { type: 'string' },
            name: { type: 'string' },
            composeFiles: {
              type: 'array',
              items: { $ref: '#/components/schemas/DeployPreviewComposeFile' },
            },
            services: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
      projectName: {
        type: 'string',
        description:
          'Docker Compose project name (`-p`) — the TurboPanel project UUID (never a display-name slug)',
      },
      containers: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'serviceId',
            'composeServiceName',
            'containerName',
            'ordinal',
            'role',
          ],
          properties: {
            serviceId: { type: 'string' },
            composeServiceName: { type: 'string' },
            containerName: { type: 'string' },
            ordinal: { type: 'integer', minimum: 1 },
            role: {
              type: 'string',
              enum: ['service', 'ingress', 'turbopanel'],
              description:
                "Workload replica (`service`), per-service Traefik container (`ingress`, named `<serviceId>-in` at ordinal 1), or platform `turbopanel-system` stack container (`turbopanel`).",
            },
          },
        },
      },
      volumes: {
        type: 'array',
        items: {
          type: 'object',
          required: ['storageId', 'composeKey', 'volumeName'],
          properties: {
            storageId: { type: 'string' },
            composeKey: { type: 'string' },
            volumeName: { type: 'string' },
          },
        },
      },
      warnings: {
        type: 'array',
        items: { $ref: '#/components/schemas/DeployPreviewWarning' },
      },
      envFile: {
        type: 'string',
        description:
          'Generated Compose project .env for non-secret interpolation. Secret values are omitted.',
      },
      secretPlan: {
        type: 'array',
        description:
          'Compose standalone secret file plan (paths and names only — never plaintext).',
        items: {
          type: 'object',
          required: [
            'key',
            'composeServiceName',
            'source',
            'target',
            'relativePath',
            'forBuild',
            'forRuntime',
          ],
          properties: {
            key: { type: 'string' },
            composeServiceName: { type: 'string' },
            source: { type: 'string' },
            target: { type: 'string' },
            relativePath: { type: 'string' },
            forBuild: { type: 'boolean' },
            forRuntime: { type: 'boolean' },
          },
        },
      },
    },
  },
  HealthCheckMissingError: {
    type: 'object',
    required: ['error', 'services'],
    properties: {
      error: { type: 'string', const: 'health_check_missing' },
      required: { type: 'boolean' },
      services: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  },
  ResourceLimitExceededError: {
    type: 'object',
    required: ['error', 'violations'],
    properties: {
      error: { type: 'string', const: 'resource_limit_exceeded' },
      violations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['organization', 'server'] },
            field: { type: 'string' },
            limit: { type: 'number' },
            requested: { type: 'number' },
          },
        },
      },
    },
  },
}

export const deployPaths = {
  '/api/client/v1/environments/{id}/deploy': {
    post: {
      tags: ['Environments'],
      summary: 'Deploy environment compose to its pinned server',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/DeployEnvironmentRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Deploy command queued',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeployEnvironmentResponse' },
            },
          },
        },
        409: {
          description:
            'Health-check, resource-limit, no eligible server (`server_placement_required`), or TurboFabric still converging (`fabric_reconcile_pending`)',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/HealthCheckMissingError' },
                  { $ref: '#/components/schemas/ResourceLimitExceededError' },
                  { $ref: '#/components/schemas/ErrorResponse' },
                ],
              },
            },
          },
        },
        422: {
          description:
            'Scheduler rejected the plan (`turbofabric_required`, `relay_endpoint_unavailable`, `fabric_segment_pool_exhausted`, `relay_missing`, `host_port_conflict`, `constraint_unsatisfiable`, `colocation_conflict`, `fabric_reconcile_failed`)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/deploy-preview': {
    get: {
      tags: ['Environments'],
      summary: 'Preview the exact compose document that deploy would send',
      description:
        'Runs the same prepareDeployCompose path as deploy (including idempotent container allocation and volume registration) but skips daemon sealing. Secret-backed variable values are redacted. `composeFiles` is the compiled runtime snapshot for the first participating server; `servers[]` lists every host. Prepare gates surface as warnings so the preview always renders.',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Deploy preview',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeployPreviewResponse' },
            },
          },
        },
        409: {
          description: 'No eligible server (`server_placement_required`)',
        },
        422: {
          description:
            'Scheduler rejected the plan (`turbofabric_required`, `relay_endpoint_unavailable`, `fabric_segment_pool_exhausted`, `relay_missing`, `host_port_conflict`, `constraint_unsatisfiable`, `colocation_conflict`)',
        },
      },
    },
  },
}
