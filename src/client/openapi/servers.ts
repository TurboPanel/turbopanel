export const serverSchemas = {
  ServerOsMetadata: {
    type: 'object',
    description:
      'Host OS reported by the daemon from /etc/os-release (plus Deno build arch/family).',
    properties: {
      family: {
        type: 'string',
        enum: ['linux', 'windows', 'freebsd', 'darwin'],
      },
      id: {
        type: 'string',
        description: 'Distro id from os-release ID= (e.g. debian, raspbian).',
      },
      variant: {
        type: 'string',
        enum: ['raspberry-pi-os'],
        description:
          'Set when the host is Raspberry Pi OS (including 64-bit images that still report ID=debian).',
      },
      version: {
        type: 'string',
        description:
          'Point release when available (e.g. 13.5 from DEBIAN_VERSION_FULL), else VERSION_ID.',
      },
      versionCodename: {
        type: 'string',
        description: 'VERSION_CODENAME (e.g. trixie).',
      },
      prettyName: {
        type: 'string',
        description: 'Raw PRETTY_NAME from os-release.',
      },
      arch: { type: 'string', description: 'CPU arch (e.g. aarch64, x86_64).' },
    },
  },
  ServerTimeSync: {
    type: 'object',
    description:
      'Host timezone + NTP state from daemon hello / change-detected heartbeat.',
    properties: {
      timezone: { type: 'string' },
      ntpEnabled: { type: 'boolean' },
      ntpSynced: { type: 'boolean' },
      ntpServers: { type: 'array', items: { type: 'string' } },
      fallbackNtpServers: { type: 'array', items: { type: 'string' } },
      capturedAt: { type: 'string', format: 'date-time' },
    },
  },
  ServerAddresses: {
    type: 'object',
    description: 'Host interface addresses reported by the daemon.',
    properties: {
      privateIpv4: { type: 'array', items: { type: 'string' } },
      privateIpv6: { type: 'array', items: { type: 'string' } },
      publicIpv4: { type: 'array', items: { type: 'string' } },
      publicIpv6: { type: 'array', items: { type: 'string' } },
    },
  },
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
      connectedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'Time the current daemon WebSocket connection was established (resets on reconnect). Null when offline.',
      },
      geo: {
        type: ['object', 'null'],
        additionalProperties: true,
        description:
          'Connecting-IP geolocation from server.metadata.geo when available.',
      },
      os: {
        oneOf: [
          { $ref: '#/components/schemas/ServerOsMetadata' },
          { type: 'null' },
        ],
        description:
          'Host OS from server.metadata.os (daemon hello). Null until the daemon has reported it.',
      },
      osDisplay: {
        type: ['string', 'null'],
        description:
          'Formatted OS label for UI, e.g. "Debian 13.5 (Trixie)". Null when os is unknown.',
      },
      osLogo: {
        type: ['string', 'null'],
        enum: ['debian', 'raspberry-pi-os', null],
        description: 'Logo key for the UI OS column.',
      },
      addresses: {
        oneOf: [
          { $ref: '#/components/schemas/ServerAddresses' },
          { type: 'null' },
        ],
        description:
          'Host addresses from server.metadata.addresses. Null until reported.',
      },
      timeSync: {
        oneOf: [
          { $ref: '#/components/schemas/ServerTimeSync' },
          { type: 'null' },
        ],
        description:
          'Host time-sync from server.metadata.timeSync. Null until reported.',
      },
      timezone: {
        type: ['string', 'null'],
        description:
          'Effective timezone (server override unless org enforceServerTimezone).',
      },
      timezoneSource: {
        type: ['string', 'null'],
        enum: ['server', 'organization', null],
        description: 'Which layer supplied the effective timezone.',
      },
      colocatedWithInstance: {
        type: 'boolean',
        description:
          'True when this server is the daemon co-located on the same host as this control plane instance.',
      },
    },
  },
  ServerDetailResponse: {
    type: 'object',
    required: ['ok', 'server'],
    properties: {
      ok: { type: 'boolean', const: true },
      server: {
        allOf: [
          { $ref: '#/components/schemas/ServerRow' },
          {
            type: 'object',
            properties: {
              orgDefaultTimezone: { type: ['string', 'null'] },
              enforceServerTimezone: { type: 'boolean' },
            },
          },
        ],
      },
    },
  },
  CommandEnqueueResponse: {
    type: 'object',
    required: ['ok', 'commandId', 'status'],
    properties: {
      ok: { type: 'boolean', const: true },
      commandId: { type: 'string', format: 'uuid' },
      status: { type: 'string', const: 'queued' },
    },
  },
  TimezoneSetRequest: {
    type: 'object',
    required: ['timezone'],
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone (must be in GET /timezones).',
      },
    },
  },
  NtpSetRequest: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      servers: { type: 'array', items: { type: 'string' }, minItems: 1 },
      fallbackServers: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
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
      lastUpdateError: {
        type: 'string',
        description:
          'Error from the most recent terminal update attempt, when present.',
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
  ServerDeleteBlockersConflict: {
    type: 'object',
    required: ['error', 'code', 'blockers'],
    properties: {
      error: {
        type: 'string',
        const: 'Cannot delete this server while dependent resources still exist',
      },
      code: { type: 'string', const: 'server_has_blockers' },
      blockers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind', 'count'],
          properties: {
            kind: { type: 'string', enum: ['network', 'container'] },
            count: { type: 'integer', minimum: 1 },
          },
        },
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
    get: {
      tags: ['Servers'],
      summary: 'Get a single server detail row',
      description:
        'Returns display fields plus live presence (addresses, timeSync, effective timezone). Uses the server-detail cached read model for the row SELECT; presence enrichment is primary-DB only.',
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
          description: 'Server detail',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ServerDetailResponse' },
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
      },
    },
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
          description: 'Dependent resources block deletion',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ServerDeleteBlockersConflict' },
                  { $ref: '#/components/schemas/HierarchyDeleteConflict' },
                ],
              },
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
  '/api/client/v1/servers/{id}/timezone': {
    post: {
      tags: ['Servers'],
      summary: 'Set server timezone',
      description:
        'Persists server.options.timezone and enqueues server.timezone.set. Manage-gated; poll via GET /servers/{id}/commands/{commandId}.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/TimezoneSetRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Command queued',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CommandEnqueueResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid timezone',
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
      },
    },
  },
  '/api/client/v1/servers/{id}/ntp': {
    post: {
      tags: ['Servers'],
      summary: 'Configure server NTP',
      description:
        'Enqueues server.ntp.set. Manage-gated; poll via GET /servers/{id}/commands/{commandId}.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/NtpSetRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Command queued',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CommandEnqueueResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid NTP payload',
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
      },
    },
  },
}
