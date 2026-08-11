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
      commandId: { type: 'string' },
      status: { type: 'string', const: 'queued' },
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
  DeployPreviewResponse: {
    type: 'object',
    required: ['ok', 'composeYaml', 'projectName', 'containers', 'volumes', 'warnings'],
    properties: {
      ok: { type: 'boolean', const: true },
      composeYaml: {
        type: 'string',
        description:
          'Exact runtime compose YAML prepare would send the daemon; secret values redacted',
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
          description: 'Health-check or resource-limit conflict',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/HealthCheckMissingError' },
                  { $ref: '#/components/schemas/ResourceLimitExceededError' },
                ],
              },
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
        'Runs the same prepareDeployCompose path as deploy (including idempotent container allocation and volume registration) but skips daemon sealing. Secret-backed variable values are redacted. Prepare gates surface as warnings so the preview always renders.',
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
          description: 'Environment has no pinned server',
        },
      },
    },
  },
}
