export const readinessSchemas = {
  DaemonErrorResponse: {
    type: 'object',
    required: ['error'],
    properties: {
      error: { type: 'string' },
    },
  },
}

export const readinessPaths: Record<string, unknown> = {
  '/api/daemon/v1/readiness': {
    get: {
      tags: ['daemon'],
      summary: 'Install readiness probe',
      description:
        'Co-located self-hosted daemons poll this before opening the daemon WebSocket. ' +
        'Returns 503 until the install wizard has created org + superadmin.',
      responses: {
        '200': {
          description: 'Instance is ready for daemon connections',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'ready'],
                properties: {
                  ok: { type: 'boolean', const: true },
                  ready: { type: 'boolean', const: true },
                },
              },
            },
          },
        },
        '503': {
          description: 'Not ready or database unavailable',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['ok', 'ready', 'needsInstall'],
                    properties: {
                      ok: { type: 'boolean', const: true },
                      ready: { type: 'boolean', const: false },
                      needsInstall: { type: 'boolean', const: true },
                    },
                  },
                  {
                    type: 'object',
                    required: ['ok', 'error'],
                    properties: {
                      ok: { type: 'boolean', const: false },
                      error: { type: 'string' },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
}
