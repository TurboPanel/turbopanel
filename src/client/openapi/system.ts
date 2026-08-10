export const systemSchemas = {
  SystemComponentRestartResponse: {
    type: 'object',
    required: ['ok', 'commandId', 'status', 'serverId'],
    properties: {
      ok: { type: 'boolean', const: true },
      commandId: { type: 'string', format: 'uuid' },
      status: { type: 'string', const: 'queued' },
      serverId: { type: 'string', format: 'uuid' },
    },
  },
}

export const systemPaths = {
  '/api/client/v1/servers/{id}/system/{component}/restart': {
    post: {
      tags: ['System'],
      summary: 'Restart a platform-managed system component on a server',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description: 'Server id',
        },
        {
          name: 'component',
          in: 'path',
          required: true,
          schema: { type: 'string', enum: ['hosting-ingress', 'managed-ingress'] },
          description: 'System component allowlist key',
        },
      ],
      responses: {
        '200': {
          description: 'Restart command queued',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SystemComponentRestartResponse' },
            },
          },
        },
        '400': {
          description: 'Unknown system component',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string', const: 'unknown_system_component' },
                },
              },
            },
          },
        },
        '403': { description: 'Forbidden (missing system:operate)' },
        '404': {
          description: 'Server not found or system component not provisioned',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'string',
                    enum: ['Not found', 'system_component_not_provisioned'],
                  },
                },
              },
            },
          },
        },
        '503': {
          description: 'Operate transport unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string', const: 'system_reconcile_unavailable' },
                },
              },
            },
          },
        },
      },
    },
  },
}
