export const managedSchemas = {
  ManagedEnvironmentRow: {
    type: 'object',
    required: [
      'id',
      'environmentId',
      'displayName',
      'engine',
      'status',
      'host',
      'port',
      'serverId',
      'metadata',
      'options',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      environmentId: { type: 'string', nullable: true },
      displayName: { type: 'string', nullable: true },
      engine: {
        type: 'string',
        nullable: true,
        enum: ['postgres', 'mysql', 'mariadb', 'redis', 'clickhouse'],
      },
      status: {
        type: 'string',
        enum: ['provisioning', 'ready', 'failed'],
      },
      host: { type: 'string', nullable: true },
      port: { type: 'number', nullable: true },
      serverId: {
        type: 'string',
        nullable: true,
        description: 'Derived from `environment.server_id`',
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description:
          'Residual metadata only (`rootPrincipalId`, `error`). Engine/status/host/port are top-level.',
      },
      options: { type: 'object', additionalProperties: true, nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ManagedEnvironmentResponse: {
    type: 'object',
    required: ['managed'],
    properties: {
      managed: {
        oneOf: [
          { $ref: '#/components/schemas/ManagedEnvironmentRow' },
          { type: 'null' },
        ],
      },
    },
  },
  ProvisionManagedRequest: {
    type: 'object',
    properties: {
      displayName: {
        type: 'string',
        description: 'Optional display name; defaults to the environment name',
      },
    },
  },
  ProvisionManagedResponse: {
    type: 'object',
    required: ['ok', 'managed'],
    properties: {
      ok: { type: 'boolean', const: true },
      alreadyProvisioned: {
        type: 'boolean',
        description: 'True when an existing managed row was returned unchanged',
      },
      managed: { $ref: '#/components/schemas/ManagedEnvironmentRow' },
    },
  },
  NotManagedEnvironmentError: {
    type: 'object',
    required: ['error'],
    properties: {
      error: { type: 'string', const: 'not_managed_environment' },
    },
  },
  ServerPlacementRequiredError: {
    type: 'object',
    required: ['error'],
    properties: {
      error: { type: 'string', const: 'server_placement_required' },
    },
  },
}

export const managedPaths = {
  '/api/client/v1/environments/{id}/managed': {
    get: {
      tags: ['Environments'],
      summary: 'Get the managed service row for an environment',
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
          description: 'Managed row, or null when not yet provisioned',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ManagedEnvironmentResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/provision': {
    post: {
      tags: ['Environments'],
      summary: 'Provision an environment-scoped managed engine service',
      description:
        'Requires organization:manage on the environment and a placement pin on `environment.server_id`. Idempotent when a managed row already exists.',
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
            schema: { $ref: '#/components/schemas/ProvisionManagedRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Managed service provisioned (or existing row returned)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProvisionManagedResponse' },
            },
          },
        },
        400: {
          description: 'Environment is not a managed engine project',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NotManagedEnvironmentError' },
            },
          },
        },
        409: {
          description:
            '`server_placement_required` — environment has no `server_id` placement pin',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServerPlacementRequiredError' },
            },
          },
        },
      },
    },
  },
}
