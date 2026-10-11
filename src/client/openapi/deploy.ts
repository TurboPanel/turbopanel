/** Rollout settings the effective strategy ignores; present only when there are some. */
const ROLLOUT_WARNINGS_SCHEMA = {
  type: 'array',
  description:
    'Advisory compose lint warnings for rollout settings this deploy ignores: `deploy.update_config.parallelism` on an `inplace` deploy, which updates every server at once. Never blocking.',
  items: {
    type: 'object',
    required: ['level', 'message', 'path'],
    properties: {
      level: { type: 'string', enum: ['warning'] },
      message: { type: 'string' },
      path: { type: 'string' },
      blocking: { type: 'boolean', enum: [false] },
    },
  },
}

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
      strategy: {
        type: 'string',
        enum: ['inplace', 'sequential', 'bluegreen'],
        description:
          'Per-deploy override of the environment deploy strategy. `inplace` and `sequential` ' +
          'are honored; `bluegreen` has no engine yet and is refused with ' +
          '`501 deploy_strategy_unsupported` rather than ignored.',
      },
      migration: {
        type: 'string',
        enum: ['none', 'compatible', 'breaking', 'unknown'],
        description:
          'Per-deploy override of the environment migration status ("this deploy contains a ' +
          'breaking migration"). **Not honored yet**: refused with `501 deploy_strategy_unsupported`.',
      },
      ref: {
        type: 'string',
        maxLength: 255,
        description:
          'Branch, tag, or commit SHA to deploy for Git-backed services. Equivalent to what a ' +
          'push webhook would trigger, for instances GitHub cannot reach. **Not honored yet**: ' +
          "checking a ref out is the release-engine phase's job, so a request that sets this " +
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
      warnings: {
        type: 'array',
        description:
          'Present only when a Node.js app runs on the default Node version because its repository could not be read: a disabled app, or a rollback to a release recorded before its Node version was. Each says what happened and how to pin `x-turbopanel.nodeVersion`.',
        items: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', enum: ['node_version_unresolved'] },
            message: { type: 'string' },
          },
        },
      },
      strategy: {
        type: 'object',
        description:
          'The deploy strategy this deploy was queued with. `effective` is what the host runs (`inplace` or `sequential`); it differs from `requested` when `bluegreen` was asked for and not available. How the deploy ends (`rolled_back`, `needs_attention`) is reported on the deployment history entry once the host answers.',
        required: ['requested', 'effective', 'fallbackReasons', 'rollout'],
        properties: {
          rollout: {
            type: 'object',
            description:
              'Rolling deploy across servers. `parallelism` is how many servers update at once (compose `deploy.update_config.parallelism`; default 1, `0` = all at once; an `inplace` deploy reports 0). `batches` is how many batches the deploy delivers in order. Batch 1 is queued now; each next batch is queued when the one before is applied, and the first failed server stops the rollout: servers not yet started are marked failed and their commands cancelled.',
            required: ['parallelism', 'batches'],
            properties: {
              parallelism: { type: 'integer', minimum: 0 },
              batches: { type: 'integer', minimum: 0 },
              warnings: ROLLOUT_WARNINGS_SCHEMA,
            },
          },
          requested: { type: 'string', enum: ['inplace', 'sequential', 'bluegreen'] },
          effective: { type: 'string', enum: ['inplace', 'sequential'] },
          fallbackReasons: {
            type: 'array',
            items: {
              type: 'object',
              required: ['code', 'message', 'services'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                services: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      commands: {
        type: 'array',
        description:
          'Every queued `environment.deploy` (and drained-server stop) command. On a rolling deploy this is the first batch only; later batches are queued as the one before them is applied.',
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
          'site_cron_unowned',
          'php_mode_not_allowed',
          'node_version_unresolved',
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
      'strategy',
      'effectiveStrategy',
      'migrations',
      'fallbackReasons',
      'rollout',
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
          required: ['serviceId', 'composeServiceName', 'containerName', 'ordinal', 'role'],
          properties: {
            serviceId: { type: 'string' },
            composeServiceName: { type: 'string' },
            containerName: { type: 'string' },
            ordinal: { type: 'integer', minimum: 1 },
            role: {
              type: 'string',
              enum: ['service', 'ingress', 'turbopanel'],
              description:
                'Workload replica (`service`), ingress frontend (`ingress` — per-service Traefik or shared per-server ProxySQL managed-ingress, both named `<serviceId>-in` at ordinal 1), or platform `turbopanel-system` stack / Orchestrator container (`turbopanel`).',
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
      strategy: {
        type: 'string',
        enum: ['inplace', 'sequential', 'bluegreen'],
        description:
          'The strategy requested: the `strategy` query, else the environment setting, else `inplace`.',
      },
      effectiveStrategy: {
        type: 'string',
        enum: ['inplace', 'sequential', 'bluegreen'],
        description:
          'The strategy a deploy would actually run (`inplace` or `sequential`). Differs from `strategy` only when `bluegreen` is requested: it runs as `sequential` for now (see `fallbackReasons`).',
      },
      rollout: {
        type: 'object',
        description:
          'Rolling deploy across servers. `parallelism` is how many servers update at once (compose `deploy.update_config.parallelism`; default 1, `0` = all at once; an `inplace` deploy reports 0). `batches` is how many batches the deploy delivers in order. Batch 1 is queued now; each next batch is queued when the one before is applied, and the first failed server stops the rollout: servers not yet started are marked failed and their commands cancelled.',
        required: ['parallelism', 'batches'],
        properties: {
          parallelism: { type: 'integer', minimum: 0 },
          batches: { type: 'integer', minimum: 0 },
          warnings: ROLLOUT_WARNINGS_SCHEMA,
        },
      },
      migrations: {
        type: 'string',
        enum: ['none', 'compatible', 'breaking', 'unknown'],
        description: 'Migration status the decision used; `unknown` when none is declared.',
      },
      fallbackReasons: {
        type: 'array',
        description: 'Every reason blue-green is refused; empty when no fallback applies.',
        items: {
          type: 'object',
          required: ['code', 'message', 'services'],
          properties: {
            code: {
              type: 'string',
              enum: [
                'host_published_ports',
                'authored_container_name',
                'stateful_writable_volume',
                'missing_healthcheck',
                'native_or_cron_service',
                'host_level_binds',
                'migration_unknown',
                'migration_breaking',
                'bluegreen_unavailable',
                'migrator_undeclared',
              ],
            },
            message: { type: 'string' },
            services: { type: 'array', items: { type: 'string' } },
          },
        },
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
      nativeAppVariables: {
        type: 'array',
        description:
          "For each Node.js app (native service) in the deploy: every environment variable its process gets, where each one comes from, and whether it reaches the process. Secret values are never shown (`value` is null). The platform sets HOST, HOSTNAME, NODE_ENV and PORT itself; a variable of one of those names is listed with `delivered: false`. A secret set directly on the app (service or hostname) is passed automatically; a secret set higher up is passed only when the app's environment references it as `{$KEY}`, and is otherwise listed with `delivered: false, reason: not_referenced`.",
        items: {
          type: 'object',
          required: ['composeServiceName', 'variables'],
          properties: {
            composeServiceName: { type: 'string' },
            variables: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'source', 'isSecret', 'value', 'delivered'],
                properties: {
                  name: { type: 'string' },
                  source: {
                    type: 'string',
                    description:
                      'Where the value was set: `organization`, `workspace`, `project`, `environment`, `service`, `hosting`, `server`, `binding` (a managed database), `platform` (set by TurboPanel for every app) or `unknown`.',
                  },
                  isSecret: { type: 'boolean' },
                  value: { type: 'string', nullable: true },
                  delivered: { type: 'boolean' },
                  reason: {
                    type: 'string',
                    enum: [
                      'platform',
                      'invalid_name',
                      'invalid_value',
                      'too_many',
                      'not_referenced',
                    ],
                    description: 'Why a variable that was set does not reach the process.',
                  },
                },
              },
            },
          },
        },
      },
      nativeAppNodeVersions: {
        type: 'array',
        description:
          "For each Node.js app (native service) in the deploy, once: the Node version it runs and where that came from. The service's own `x-turbopanel.nodeVersion` wins, except on a rollback, which runs the version the release recorded (`release`), since that is what its tree was built on; otherwise the repository is read at the commit being deployed: `package.json` `engines.node` (the newest offered version that satisfies it), then `.nvmrc`, then `.node-version`, in the service's subdirectory first and then the repository root. With none of those, the platform default is used. `unresolved` means the preview could not read the repository; `nodeVersion` is then absent and `note` says what the deploy will do.",
        items: {
          type: 'object',
          required: ['composeServiceName', 'source'],
          properties: {
            composeServiceName: { type: 'string' },
            nodeVersion: { type: 'string', description: 'Node major version, such as `24`.' },
            source: {
              type: 'string',
              enum: [
                'compose',
                'release',
                'package.json',
                '.nvmrc',
                '.node-version',
                'default',
                'unresolved',
              ],
            },
            note: {
              type: 'string',
              description: 'Plain-words explanation, when the answer needs one.',
            },
            requested: {
              type: 'string',
              description: 'What the file asked for, such as `>=26.7.0`.',
            },
            path: {
              type: 'string',
              description: 'The repository file it was read from, such as `apps/web/package.json`.',
            },
          },
        },
      },
      nativeAppDenoVersions: {
        type: 'array',
        description:
          'For each Deno app (a native service with `x-turbopanel.runtime: deno`) in the deploy, once: the Deno series it runs. Deno ships one major version (2) and the server runs its newest release, so `2.9` and `2.9.7` both mean series `2`. `compose` means `x-turbopanel.denoVersion` pinned it; `default` means the platform default. A server whose TurboPanel daemon is too old to run Deno apps refuses the deploy with `deno_feature_missing` (422).',
        items: {
          type: 'object',
          required: ['composeServiceName', 'denoVersion', 'source'],
          properties: {
            composeServiceName: { type: 'string' },
            denoVersion: { type: 'string', description: 'Deno major version, such as `2`.' },
            source: { type: 'string', enum: ['compose', 'default'] },
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
        description:
          'Command lifecycle status (`queued`, `sent`, `succeeded`, `failed`, `timed_out`, …).',
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
      errorLine: {
        type: ['string', 'null'],
        description:
          'The one line of `errorMessage` that says what went wrong (the cause is printed last). Signed URLs are redacted. Null when the attempt has no error text.',
      },
      strategy: {
        type: ['string', 'null'],
        enum: ['inplace', 'sequential', null],
        description:
          'The deploy engine this attempt ran. Null for attempts queued before it was recorded.',
      },
      strategyOutcome: {
        type: ['string', 'null'],
        enum: ['rolled_back', 'needs_attention', null],
        description:
          'How a sequential deploy that did not finish ended: `rolled_back` (the previous version is running again) or `needs_attention` (stopped on purpose, for example because a migration already ran so the old version was not restarted). `errorCode` is `deploy_rolled_back` / `deploy_needs_attention`. Null otherwise.',
      },
      strategyOutcomeReason: {
        type: ['string', 'null'],
        description: 'Why the deploy rolled back or needs attention.',
      },
      cancelRequestedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'When someone asked for this attempt to be cancelled. With a live `status` the deploy is "cancelling"; with `succeeded` the cancel came too late and the deploy finished anyway; `status: cancelled` (`errorCode` `deploy_cancelled`) is the terminal state, with the previous version still serving.',
      },
      hasLog: {
        type: 'boolean',
        description:
          'Whether an execution-log transcript is retained. Resolved store-side — there is no Postgres column.',
      },
      trigger: {
        description:
          'What set this attempt off when it was a git push (`actorEntityType` is `system`); null for a deploy a person started. Read from the attribution recorded on the command, so it outlives the daemon payload.',
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            required: ['kind', 'branch', 'commitSha', 'sourceId'],
            properties: {
              kind: { type: 'string', const: 'push' },
              branch: {
                type: ['string', 'null'],
                description: 'Branch that was pushed, without the `refs/heads/` prefix.',
              },
              commitSha: { type: ['string', 'null'], description: 'Head commit of the push.' },
              sourceId: {
                type: ['string', 'null'],
                description: 'The repository (`repository.id`) the push came from.',
              },
            },
          },
        ],
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
    required: ['id', 'environmentId', 'replicaCounts', 'totalReplicas', 'commands', 'servers'],
    properties: {
      id: { type: 'string' },
      environmentId: { type: 'string' },
      generation: { type: ['integer', 'null'] },
      desiredHash: { type: ['string', 'null'] },
      replicaCounts: {
        type: 'object',
        additionalProperties: { type: 'integer', minimum: 1 },
        description:
          "Per-service replica counts for the whole fan-out, summed across every participating host from each attempt's historical `command.context`. Empty when no attempt in the fan-out carries counts (rows queued before they were persisted).",
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
              description: "Sum of this host's `replicaCounts`; null when unknown.",
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
            'Scheduler rejected the plan (`turbofabric_required`, `relay_endpoint_unavailable`, `fabric_segment_pool_exhausted`, `relay_missing`, `host_port_conflict`, `constraint_unsatisfiable`, `colocation_conflict`, `max_replicas_per_node_exceeded`, `fabric_reconcile_failed`)',
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
        "`deploymentId` is a `command.id`. The response groups every `environment.deploy` command sharing the anchor's `context.generation` — the full fan-out, unpaginated and untruncated, so every participating host can be enumerated. Replica counts (`replicaCounts` / `totalReplicas`) are historical, read from each attempt's `command.context`. The per-server convergence figures (`appliedGeneration`, `desiredGeneration`, `deploymentStatus`) instead come from a live join to `deployment` and therefore reflect current state, not a snapshot taken at deploy time.",
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
  '/api/client/v1/environments/{id}/deployments/{deploymentId}/cancel': {
    post: {
      tags: ['Environments'],
      summary: 'Cancel a deploy that is queued or running',
      description:
        "`deploymentId` is a `command.id`; the whole deploy is cancelled (every server of that generation, and any rollout batch still waiting). A queued deploy is cancelled outright (`state: cancelled`). A running one is asked to stop (`state: cancelling`): the host only honours that before it switches anything over, so the previous version keeps serving, and the deploy's own outcome later reads `status: cancelled` in the history (`cancelRequestedAt` marks it meanwhile). Needs manage on the environment. No step-up: a re-deploy fully reverses a cancel. Idempotent: an already-cancelled deploy answers `already_cancelled`.",
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'deploymentId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: {
          description: 'Cancelled, cancelling, or already cancelled',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'state', 'environmentId', 'deploymentId'],
                properties: {
                  ok: { type: 'boolean', enum: [true] },
                  state: { type: 'string', enum: ['cancelled', 'cancelling', 'already_cancelled'] },
                  environmentId: { type: 'string' },
                  deploymentId: { type: 'string' },
                },
              },
            },
          },
        },
        403: { description: 'Caller cannot manage this environment' },
        404: { description: 'No such deploy attempt for this environment' },
        409: {
          description:
            "`deploy_not_cancellable` (already finished), `deploy_too_late` (the host is already switching over and will finish), or `cancel_unsupported` (the server's daemon is too old to cancel)",
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        503: { description: '`daemon_unavailable`: the control plane has no link to the server' },
      },
    },
  },
  '/api/client/v1/environments/{id}/stop': {
    post: {
      tags: ['Environments'],
      summary: 'Stop an environment and remove what it runs',
      description:
        'Queues one `environment.stop` command per server the environment runs on: the compose project is taken down (containers, networks and volumes are removed), the environment\'s sites\' release trees are reclaimed and the host\'s ingress is reconciled. The environment record and its settings stay, so a later deploy starts it again. This is the teardown to use when cleaning up a test environment. A rollout still waiting for its next batch is cancelled. Needs manage on the environment, and a recent step-up when the organization requires one (403 `reauth_required`). Poll each command with `GET /servers/{serverId}/commands/{commandId}`. For a stop that keeps volumes use `POST /environments/{id}/lifecycle` with `{"action": "stop"}`.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Stop command(s) queued',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeployEnvironmentResponse' },
            },
          },
        },
        401: { description: 'No session' },
        403: { description: 'Caller cannot manage this environment, or `reauth_required`' },
        404: { description: 'No such environment' },
        503: {
          description: 'The control plane has no link to the command queue or database',
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/lifecycle': {
    post: {
      tags: ['Environments'],
      summary: 'Start, stop or restart an environment without removing it',
      description:
        'Queues one `environment.lifecycle` command per server the environment runs on. Unlike `POST /environments/{id}/stop` this keeps containers, networks and volumes. A rollout still waiting for its next batch is cancelled. Needs manage on the environment. Poll each command with `GET /servers/{serverId}/commands/{commandId}`.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['action'],
              properties: { action: { type: 'string', enum: ['start', 'stop', 'restart'] } },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Lifecycle command(s) queued',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeployEnvironmentResponse' },
            },
          },
        },
        400: { description: 'Invalid request (unknown `action`)' },
        401: { description: 'No session' },
        403: { description: 'Caller cannot manage this environment' },
        404: { description: 'No such environment' },
        503: {
          description: 'The control plane has no link to the command queue or database',
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
        {
          name: 'strategy',
          in: 'query',
          required: false,
          description: 'What-if: preview as if this strategy were requested.',
          schema: { type: 'string', enum: ['inplace', 'sequential', 'bluegreen'] },
        },
        {
          name: 'migration',
          in: 'query',
          required: false,
          description: 'What-if: preview as if this migration status were declared.',
          schema: { type: 'string', enum: ['none', 'compatible', 'breaking', 'unknown'] },
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
            'Scheduler rejected the plan (`turbofabric_required`, `relay_endpoint_unavailable`, `fabric_segment_pool_exhausted`, `relay_missing`, `host_port_conflict`, `constraint_unsatisfiable`, `colocation_conflict`, `max_replicas_per_node_exceeded`)',
        },
      },
    },
  },
}
