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
      lastInboundAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'Last inbound WebSocket activity recorded in the daemon cell snapshot. Servers with no activity for 60s are treated as offline. Null when the daemon has never connected.',
      },
      lastHeartbeatAt: {
        type: ['string', 'null'],
        format: 'date-time',
        deprecated: true,
        description:
          'Deprecated alias for lastInboundAt.',
      },
      connectedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'Time the current daemon WebSocket connection was established (resets on reconnect). Null when offline.',
      },
      colocatedWithInstance: {
        type: 'boolean',
        description:
          'True when this server is the daemon co-located on the same host as this control plane instance.',
      },
    },
  },
  FetchServerCellResponse: {
    type: 'object',
    required: ['ok', 'snapshot'],
    properties: {
      ok: { type: 'boolean', const: true },
      snapshot: { type: 'object', additionalProperties: true },
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
      colocatedWithInstance: {
        type: 'boolean',
        description:
          'True when this server is the daemon co-located on the same host as this control plane instance.',
      },
      updateBlocked: {
        type: 'boolean',
        description:
          'True when the co-located development daemon cannot be updated remotely.',
      },
      updateBlockedReason: {
        type: 'string',
        description:
          'Human-readable reason remote updates are blocked for this server.',
      },
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
  DeleteServerResponse: {
    type: 'object',
    required: ['ok', 'serverId'],
    properties: {
      ok: { type: 'boolean', const: true },
      serverId: { type: 'string', format: 'uuid' },
    },
  },
  DeleteServerPartialFailure: {
    type: 'object',
    required: ['ok', 'serverId', 'deleted', 'error'],
    properties: {
      ok: { type: 'boolean', const: false },
      serverId: { type: 'string', format: 'uuid' },
      deleted: { type: 'boolean', const: true },
      error: {
        type: 'string',
        description: 'The Postgres row was deleted but daemon cell purge did not complete.',
      },
    },
  },
  HierarchyDeleteConflict: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'string',
        const: 'Cannot delete while child resources exist',
      },
    },
  },
}

export const serverPaths: Record<string, unknown> = {
  '/api/client/v1/servers': {
    get: {
      tags: ['Servers'],
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
  '/api/client/v1/servers/{id}/cell': {
    get: {
      tags: ['Servers'],
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
      tags: ['Servers'],
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
      tags: ['Servers'],
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
          description:
            'Forbidden, or update blocked for the co-located development daemon',
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
  '/api/client/v1/servers/{id}/update/reset': {
    post: {
      tags: ['Servers'],
      summary: 'Clear stale daemon update status after a manual node update',
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
          description: 'Terminal update request history cleared',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/ServerUpdateStatusResponse' },
                  {
                    type: 'object',
                    required: ['cleared'],
                    properties: {
                      cleared: { type: 'integer', minimum: 0 },
                    },
                  },
                ],
              },
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
        '409': {
          description: 'Update in progress',
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
      },
    },
  },
  '/api/client/v1/servers/{id}': {
    delete: {
      tags: ['Servers'],
      summary: 'Delete a server and purge its daemon cell',
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
          description: 'Server deleted and daemon cell purged',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeleteServerResponse' },
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
        '409': {
          description: 'Child resources block deletion',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HierarchyDeleteConflict' },
            },
          },
        },
        '503': {
          description: 'Database or daemon cell registry unavailable',
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
        '500': {
          description:
            'Server row deleted but daemon cell purge failed; cleanup is incomplete',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeleteServerPartialFailure' },
            },
          },
        },
      },
    },
  },
}
