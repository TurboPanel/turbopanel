export function buildLicenseSchemas(installCommandDescription: string) {
  return {
    LicenseRecord: {
      type: 'object',
      required: ['id', 'name', 'createdAt', 'revocable', 'boundServer'],
      properties: {
        id: { type: 'string' },
        name: { type: ['string', 'null'] },
        createdAt: { type: 'string', format: 'date-time' },
        revocable: {
          type: 'boolean',
          description:
            'When false, this license is for the co-located control plane daemon and cannot be invalidated.',
        },
        boundServer: {
          oneOf: [
            {
              type: 'object',
              required: ['id', 'name', 'connected'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: ['string', 'null'] },
                connected: { type: 'boolean' },
              },
            },
            { type: 'null' },
          ],
          description:
            'Bound server when exactly one server in the org references this license; null when unbound or ambiguously bound.',
        },
      },
    },
    LicensesResponse: {
      type: 'object',
      required: ['licenses'],
      properties: {
        licenses: {
          type: 'array',
          items: { $ref: '#/components/schemas/LicenseRecord' },
        },
      },
    },
    CreateLicenseRequest: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        installBaseUrl: {
          type: 'string',
          description:
            'Development only: public http(s) URL for install command --host and download paths.',
        },
      },
    },
    CreateLicenseResponse: {
      type: 'object',
      required: ['licenseId', 'licenseToken', 'installCommand'],
      properties: {
        licenseId: { type: 'string' },
        licenseToken: {
          type: 'string',
          description: 'Shown once at creation; not stored in plaintext.',
        },
        installCommand: {
          type: 'string',
          description: installCommandDescription,
        },
      },
    },
    InvalidateOkResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', const: true },
      },
    },
    LicenseHasAttachedServerError: {
      type: 'object',
      required: ['error', 'server'],
      properties: {
        error: { type: 'string', const: 'license_has_attached_server' },
        server: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            name: { type: ['string', 'null'] },
          },
        },
      },
    },
  }
}

export function buildLicensePaths(_installCommandDescription: string): Record<string, unknown> {
  return {
    '/api/client/v1/licenses': {
      get: {
        tags: ['Licenses'],
        summary: 'List active licenses for org',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': {
            description: 'Active licenses for the signed-in organization',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LicensesResponse' },
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
      post: {
        tags: ['Licenses'],
        summary: 'Create a license',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateLicenseRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'License created; token shown once',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateLicenseResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid request',
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
          '409': {
            description:
              'Self-hosted: server seat capacity exceeded (maxServers; enrolled servers and unconsumed keys both count). Hosted: `no_license_available` — every purchased license is held (bound or waiting to connect) or ending at the period boundary; `message` is the sentence to show (it never calls an ending license "in use"), and the counts say whether to restore (`ending > 0`, `POST /billing/restore`) or buy. Also `billing_mutation_in_progress` while the organization quantity lease is held.',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: [
                        'error',
                        'maxServers',
                        'usedSeats',
                        'serverCount',
                        'reservedSeatCount',
                      ],
                      properties: {
                        error: { type: 'string', const: 'server_capacity_exceeded' },
                        maxServers: { type: ['integer', 'null'] },
                        usedSeats: { type: 'integer' },
                        serverCount: { type: 'integer' },
                        reservedSeatCount: { type: 'integer' },
                      },
                    },
                    {
                      type: 'object',
                      required: [
                        'error',
                        'message',
                        'purchased',
                        'inUse',
                        'ending',
                        'endsAt',
                        'available',
                        'tiers',
                      ],
                      properties: {
                        error: { type: 'string', const: 'no_license_available' },
                        message: {
                          type: 'string',
                          description:
                            'e.g. "3 in use, 3 end Oct 26 — restore one to add this server." or "All 3 licenses are in use — buy another to add this server."',
                        },
                        purchased: { type: 'integer' },
                        inUse: {
                          type: 'integer',
                          description: 'Licenses held: bound to a server or waiting to connect.',
                        },
                        ending: {
                          type: 'integer',
                          description: 'Licenses ending at the period boundary; restorable.',
                        },
                        endsAt: { type: ['string', 'null'], format: 'date-time' },
                        available: { type: 'integer', const: 0 },
                        tiers: {
                          type: 'array',
                          items: {
                            type: 'object',
                            required: [
                              'tierId',
                              'label',
                              'purchased',
                              'inUse',
                              'ending',
                              'endsAt',
                              'available',
                            ],
                            properties: {
                              tierId: { type: 'string', format: 'uuid' },
                              label: { type: 'string' },
                              purchased: { type: 'integer' },
                              inUse: {
                                type: 'integer',
                                description: 'Servers assigned this tier.',
                              },
                              ending: { type: 'integer' },
                              endsAt: { type: ['string', 'null'], format: 'date-time' },
                              available: { type: 'integer' },
                            },
                          },
                        },
                        releasing: {
                          type: 'integer',
                          deprecated: true,
                          description: 'Use `ending`.',
                        },
                        held: { type: 'integer', deprecated: true, description: 'Use `inUse`.' },
                      },
                    },
                    {
                      type: 'object',
                      required: ['error'],
                      properties: {
                        error: { type: 'string', const: 'billing_mutation_in_progress' },
                      },
                    },
                  ],
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
    '/api/client/v1/licenses/{id}': {
      delete: {
        tags: ['Licenses'],
        summary: 'Invalidate a license',
        description:
          'Soft-invalidates the license (sets revoked_at) when no live server is attached. A bound server must be deleted first (409). Force-revoke of daemon keys happens only on the colocated rotation path.',
        security: [{ cookieAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'License invalidated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/InvalidateOkResponse' },
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
            description: 'Co-located control plane license cannot be invalidated',
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
            description: 'License not found or already invalidated',
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
            description: 'License is still attached to a server — delete the server first',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/LicenseHasAttachedServerError',
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
}
