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
      ref: {
        type: 'string',
        maxLength: 255,
        description:
          'Branch, tag, or commit SHA to deploy for Git-backed services. Equivalent to what a ' +
          'push webhook would trigger, for instances GitHub cannot reach. **Not honored yet**: ' +
          'checking a ref out is the release-engine phase\'s job, so a request that sets this ' +
          'field is refused with `501 source_ref_unsupported` rather than deploying the ' +
          "environment's current state under a ref the caller asked for. Omit it to deploy " +
          'current state.',
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
          'site_principal_ambiguous',
          'site_managed_directory_unowned',
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
                "Workload replica (`service`), ingress frontend (`ingress` — per-service Traefik or shared per-server ProxySQL managed-ingress, both named `<serviceId>-in` at ordinal 1), or platform `turbopanel-system` stack / Orchestrator container (`turbopanel`).",
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
  DeploymentHistoryEntry: {
    type: 'object',
    description:
      'One deploy attempt against one server. Sourced from the append-only `command` table (`environment.deploy`), not from the upsert-per-target `deployment` table.',
    required: [
      'id',
      'commandId',
      'serverId',
      'status',
      'actorEntityType',
      'actorEntityId',
      'hasLog',
    ],
    properties: {
      id: {
        type: 'string',
        description: 'Deployment id — this is the `command.id` of the attempt.',
      },
      commandId: {
        type: 'string',
        description:
          'Alias of `id`; pass to `/servers/{id}/commands/{commandId}/log` for the transcript.',
      },
      generation: {
        type: ['integer', 'null'],
        description: 'Environment compose generation this attempt targeted.',
      },
      desiredHash: {
        type: ['string', 'null'],
        description: 'sha256 of the compiled runtime compose sent to this server.',
      },
      replicaCounts: {
        type: ['object', 'null'],
        additionalProperties: { type: 'integer', minimum: 1 },
        description:
          'Per-service replica counts this attempt asked the host to run, captured on `command.context` at enqueue time so it survives deletion of the daemon dispatch payload. Null for attempts queued before the counts were persisted.',
      },
      serverId: { type: 'string' },
      serverName: { type: ['string', 'null'] },
      status: {
        type: 'string',
        description: 'Command lifecycle status (`queued`, `sent`, `succeeded`, `failed`, `timed_out`, …).',
      },
      actorEntityType: { type: 'string' },
      actorEntityId: { type: 'string' },
      queuedAt: { type: ['string', 'null'], format: 'date-time' },
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      finishedAt: { type: ['string', 'null'], format: 'date-time' },
      durationMs: {
        type: ['integer', 'null'],
        description: 'Wall-clock duration of the attempt; null while still running.',
      },
      errorCode: { type: ['string', 'null'] },
      errorMessage: { type: ['string', 'null'] },
      hasLog: {
        type: 'boolean',
        description:
          'Whether an execution-log transcript is retained. Resolved store-side — there is no Postgres column.',
      },
    },
  },
  DeploymentHistoryResponse: {
    type: 'object',
    required: ['ok', 'deployments', 'nextCursor'],
    properties: {
      ok: { type: 'boolean', const: true },
      deployments: {
        type: 'array',
        description: 'Newest-first page of deploy attempts.',
        items: { $ref: '#/components/schemas/DeploymentHistoryEntry' },
      },
      nextCursor: {
        type: ['string', 'null'],
        description: 'Pass back as `before` to fetch the next (older) page; null at the end.',
      },
    },
  },
  DeploymentHistoryDetail: {
    type: 'object',
    required: [
      'id',
      'environmentId',
      'replicaCounts',
      'totalReplicas',
      'commands',
      'servers',
    ],
    properties: {
      id: { type: 'string' },
      environmentId: { type: 'string' },
      generation: { type: ['integer', 'null'] },
      desiredHash: { type: ['string', 'null'] },
      replicaCounts: {
        type: 'object',
        additionalProperties: { type: 'integer', minimum: 1 },
        description:
          'Per-service replica counts for the whole fan-out, summed across every participating host from each attempt\'s historical `command.context`. Empty when no attempt in the fan-out carries counts (rows queued before they were persisted).',
      },
      totalReplicas: {
        type: 'integer',
        description: 'Sum of `replicaCounts` across all services; 0 when unknown.',
      },
      commands: {
        type: 'array',
        description:
          'Every attempt in the same fan-out — the `environment.deploy` commands sharing this generation, one per participating server. Complete and unpaginated: every participating host is listed.',
        items: { $ref: '#/components/schemas/DeploymentHistoryEntry' },
      },
      servers: {
        type: 'array',
        description:
          'Per-server convergence read from **current** `deployment` state, not a historical snapshot — after a newer deploy `appliedGeneration` may exceed `generation`.',
        items: {
          type: 'object',
          required: ['serverId', 'status'],
          properties: {
            serverId: { type: 'string' },
            serverName: { type: ['string', 'null'] },
            status: { type: 'string', description: 'Command status for this attempt.' },
            appliedGeneration: { type: ['integer', 'null'] },
            desiredGeneration: { type: ['integer', 'null'] },
            deploymentStatus: {
              type: ['string', 'null'],
              enum: ['pending', 'applying', 'applied', 'failed', 'draining', null],
            },
            replicaCounts: {
              type: ['object', 'null'],
              additionalProperties: { type: 'integer', minimum: 1 },
              description:
                'Per-service replica counts this host was asked to run by this attempt — historical, unlike the convergence fields above.',
            },
            totalReplicas: {
              type: ['integer', 'null'],
              description: 'Sum of this host\'s `replicaCounts`; null when unknown.',
            },
          },
        },
      },
    },
  },
  DeploymentHistoryDetailResponse: {
    type: 'object',
    required: ['ok', 'deployment'],
    properties: {
      ok: { type: 'boolean', const: true },
      deployment: { $ref: '#/components/schemas/DeploymentHistoryDetail' },
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
        501: {
          description:
            '`source_ref_unsupported` — the request set `ref`, and this phase cannot check a ref out. Refused rather than silently deploying the current state.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/deployments': {
    get: {
      tags: ['Environments'],
      summary: 'List past deploy attempts for an environment',
      description:
        'Deploy history is read from the append-only `command` table (`environment.deploy` rows scoped by `context.environmentId`), not from `deployment` — that table is upserted per `(environment, server)` and only ever holds current state. Newest-first, keyset-paginated by command id (UUIDv7, so id order matches time order).',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: 'before',
          in: 'query',
          required: false,
          description: 'Return only attempts older than this deployment (command) id.',
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Deploy history page',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeploymentHistoryResponse' },
            },
          },
        },
        400: { description: 'Invalid `limit`' },
        403: { description: 'Caller cannot read this environment' },
      },
    },
  },
  '/api/client/v1/environments/{id}/deployments/{deploymentId}': {
    get: {
      tags: ['Environments'],
      summary: 'Read one deploy attempt and its multi-server fan-out',
      description:
        '`deploymentId` is a `command.id`. The response groups every `environment.deploy` command sharing the anchor\'s `context.generation` — the full fan-out, unpaginated and untruncated, so every participating host can be enumerated. Replica counts (`replicaCounts` / `totalReplicas`) are historical, read from each attempt\'s `command.context`. The per-server convergence figures (`appliedGeneration`, `desiredGeneration`, `deploymentStatus`) instead come from a live join to `deployment` and therefore reflect current state, not a snapshot taken at deploy time.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'deploymentId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: {
          description: 'Deploy attempt detail',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeploymentHistoryDetailResponse' },
            },
          },
        },
        403: { description: 'Caller cannot read this environment' },
        404: { description: 'No such deploy attempt for this environment' },
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
