export function buildLicenseSchemas(installCommandDescription: string) {
  return {
    LicenseRecord: {
      type: 'object',
      required: ['id', 'displayName', 'createdAt'],
      properties: {
        id: { type: 'string' },
        displayName: { type: ['string', 'null'] },
        createdAt: { type: 'string', format: 'date-time' },
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
        displayName: { type: 'string' },
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
    RevokeOkResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', const: true },
      },
    },
  }
}

export function buildLicensePaths(_installCommandDescription: string): Record<string, unknown> {
  return {
    '/api/client/v1/licenses': {
      get: {
        tags: ['client'],
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
        tags: ['client'],
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
        tags: ['client'],
        summary: 'Revoke a license',
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
            description: 'License revoked',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RevokeOkResponse' },
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
          '404': {
            description: 'License not found or already revoked',
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
}
