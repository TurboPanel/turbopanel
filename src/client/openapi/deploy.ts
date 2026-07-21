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
}
