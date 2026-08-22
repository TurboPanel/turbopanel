export const commandSchemas = {
  CommandStatusRecord: {
    type: 'object',
    description:
      'Lean command lifecycle projection. Never includes the daemon dispatch payload or the result summary — fetch the per-server command detail route for those.',
    required: ['id', 'serverId', 'status', 'type', 'hasLog'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      serverId: { type: 'string', format: 'uuid' },
      status: {
        type: 'string',
        description:
          'Lifecycle status (queued, dispatching, sent, acked, running, succeeded, failed, timed_out, cancelled).',
      },
      type: {
        type: 'string',
        description: 'Command name (e.g. daemon.ping, server.reboot).',
      },
      queuedAt: { type: ['string', 'null'], format: 'date-time' },
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      finishedAt: { type: ['string', 'null'], format: 'date-time' },
      errorCode: { type: ['string', 'null'] },
      errorMessage: {
        type: ['string', 'null'],
        description: 'Canonical human-readable error for terminal failures.',
      },
      hasLog: {
        type: 'boolean',
        description: 'Whether a retained execution log exists for this command.',
      },
    },
  },
  CommandLogResponse: {
    type: 'object',
    description:
      'A window of a command execution transcript. Poll with the previous response `nextSeq` as `from`.',
    required: ['ok', 'text', 'nextSeq', 'sealed', 'truncated', 'exists'],
    properties: {
      ok: { type: 'boolean', enum: [true] },
      text: {
        type: 'string',
        description:
          'Transcript bytes for this window, decoded as UTF-8. Empty when the command has produced no output yet.',
      },
      nextSeq: {
        type: 'integer',
        description: 'Sequence to send as `from` on the next poll.',
      },
      sealed: {
        type: 'boolean',
        description:
          'Whether the transcript is final. A sealed transcript will not grow; stop polling.',
      },
      truncated: {
        type: 'boolean',
        description:
          'Whether output was dropped after the retained-size cap was reached.',
      },
      exists: {
        type: 'boolean',
        description:
          'Whether any transcript is retained. `false` is the "not started" state, not an error.',
      },
    },
  },
  CommandStatusRequest: {
    type: 'object',
    required: ['ids'],
    properties: {
      ids: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: { type: 'string', format: 'uuid' },
        description: 'Command ids to look up. Deduped server-side; max 100.',
      },
    },
  },
  CommandStatusResponse: {
    type: 'object',
    required: ['ok', 'commands'],
    properties: {
      ok: { type: 'boolean', enum: [true] },
      commands: {
        type: 'array',
        items: { $ref: '#/components/schemas/CommandStatusRecord' },
        description:
          'Statuses for the requested ids that the session can see. Unknown ids and ids on servers outside the session organization are omitted rather than rejected.',
      },
    },
  },
} as const

export const commandPaths: Record<string, unknown> = {
  '/api/client/v1/commands/status': {
    post: {
      tags: ['Commands'],
      summary: 'Batched lean status for tracked commands',
      description:
        'One request for many command ids — replaces per-id polling. Ids the session cannot read are silently dropped from the response.',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CommandStatusRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Visible command statuses',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CommandStatusResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request body',
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
  '/api/client/v1/servers/{id}/commands/{commandId}/log': {
    get: {
      tags: ['Commands'],
      summary: 'Read a command execution transcript',
      description:
        'Returns a window of the command transcript starting at `from`. A command with no retained transcript returns an empty body with `exists: false` rather than 404, so a poll loop started before the daemon streams its first chunk needs no special case.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description: 'Server id.',
        },
        {
          name: 'commandId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description: 'Command id. Must belong to the server in the path.',
        },
        {
          name: 'from',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 0, default: 0 },
          description: 'Chunk sequence to resume from. Use the previous response `nextSeq`.',
        },
        {
          name: 'max',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, default: 524288 },
          description: 'Maximum transcript bytes to return. Clamped server-side.',
        },
      ],
      responses: {
        '200': {
          description: 'Transcript window',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CommandLogResponse' },
            },
          },
        },
        '403': {
          description: 'Session cannot read the server',
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
          description: 'Command not found on that server',
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
}
