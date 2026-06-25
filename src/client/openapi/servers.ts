export const serverSchemas = {
  ServerRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      organizationId: { type: ['string', 'null'] },
      licenseId: { type: ['string', 'null'] },
      options: { type: ['object', 'null'], additionalProperties: true },
      createdAt: { type: 'string', format: 'date-time' },
      connected: { type: 'boolean' },
      hostname: { type: ['string', 'null'] },
      remoteAddress: {
        type: ['string', 'null'],
        description:
          'Client IP as seen by the instance (X-Real-IP from Caddy). Null when offline or co-located on a Unix socket.',
      },
      status: {
        type: ['string', 'null'],
        description:
          'Aggregate monitor health for connected servers. Null when offline or not yet projected.',
      },
      healthyCount: {
        type: ['integer', 'null'],
        description: 'Count of healthy monitored resources. Null when offline or not yet projected.',
      },
      degradedCount: {
        type: ['integer', 'null'],
        description: 'Count of degraded monitored resources. Null when offline or not yet projected.',
      },
      unhealthyCount: {
        type: ['integer', 'null'],
        description: 'Count of unhealthy monitored resources. Null when offline or not yet projected.',
      },
      lastHeartbeatAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'Last heartbeat/inbound time recorded in the daemon cell snapshot. Null when the daemon has never connected.',
      },
      connectedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'Time the current daemon WebSocket connection was established (resets on reconnect). Null when offline.',
      },
    },
  },
  PingServerResponse: {
    type: 'object',
    required: ['ok', 'tripMs', 'sentAt', 'pongAt'],
    properties: {
      ok: { type: 'boolean', const: true },
      tripMs: { type: 'number' },
      sentAt: { type: 'string', format: 'date-time' },
      pongAt: { type: 'string', format: 'date-time' },
    },
  },
  FetchServerCellResponse: {
    type: 'object',
    required: ['ok', 'snapshot', 'resources'],
    properties: {
      ok: { type: 'boolean', const: true },
      snapshot: { type: 'object', additionalProperties: true },
      monitorInstance: { type: ['object', 'null'], additionalProperties: true },
      resources: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
  },
  ServersResponse: {
    type: 'object',
    required: ['servers'],
    properties: {
      servers: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServerRow' },
      },
    },
  },
  ServerUpdateCurrent: {
    type: 'object',
    properties: {
      commit: { type: 'string' },
      buildId: { type: 'string' },
      builtAt: { type: 'string' },
    },
  },
  ServerUpdateTarget: {
    type: 'object',
    properties: {
      commit: { type: 'string' },
      buildId: { type: 'string' },
      manifestUrl: { type: 'string' },
    },
  },
  ServerUpdateStatusResponse: {
    type: 'object',
    required: ['ok', 'serverId', 'channel', 'updateAvailable', 'status'],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string' },
      channel: { type: 'string' },
      current: {
        oneOf: [
          { $ref: '#/components/schemas/ServerUpdateCurrent' },
          { type: 'null' },
        ],
      },
      target: {
        oneOf: [
          { $ref: '#/components/schemas/ServerUpdateTarget' },
          { type: 'null' },
        ],
      },
      updateAvailable: { type: 'boolean' },
      status: { type: 'string' },
    },
  },
  TriggerServerUpdateResponse: {
    type: 'object',
    required: ['ok', 'queued', 'status'],
    properties: {
      ok: { type: 'boolean', const: true },
      queued: { type: 'boolean', const: true },
      status: { type: 'string' },
    },
  },
}

export const serverPaths: Record<string, unknown> = {
  '/api/client/v1/servers': {
    get: {
      tags: ['client'],
      summary: 'List servers for the signed-in organization',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Organization servers with live connection state',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServersResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/ping': {
    post: {
      tags: ['client'],
      summary: 'Ping a visible server daemon over WebSocket',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Round-trip ping succeeded',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PingServerResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Daemon not connected',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '504': {
          description: 'Ping timed out',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/cell': {
    get: {
      tags: ['client'],
      summary: 'Fetch daemon cell snapshot for a visible server',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Daemon cell data',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/FetchServerCellResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Server not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/update': {
    get: {
      tags: ['client'],
      summary: 'Read daemon update status for a visible server',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Current agent build vs trunk manifest target',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServerUpdateStatusResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ['client'],
      summary: 'Trigger a trunk daemon update on a connected server',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Update queued on the daemon',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TriggerServerUpdateResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Daemon not connected',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Daemon cell registry unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '504': {
          description: 'Timeout waiting for daemon acknowledgement',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'error'],
                properties: {
                  ok: { type: 'boolean', const: false },
                  error: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
}
