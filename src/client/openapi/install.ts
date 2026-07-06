export const installOpenApiSchemas = {
  InstallBootstrapRequest: {
    type: 'object',
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', description: 'Host root or sudo user' },
      password: { type: 'string', format: 'password' },
    },
  },
  InstallBootstrapResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean', const: true },
    },
  },
  InstallRequest: {
    type: 'object',
    required: ['username', 'password', 'superadminEmail', 'superadminPassword'],
    description:
      'Host credentials are required as `username` + `password`.',
    properties: {
      username: {
        type: 'string',
        description: 'Host root or sudo user.',
      },
      password: { type: 'string', format: 'password' },
      superadminEmail: { type: 'string', format: 'email' },
      superadminPassword: { type: 'string', format: 'password' },
    },
  },
}

export const installOpenApiPaths: Record<string, unknown> = {
  '/api/install/v1/bootstrap': {
    post: {
      tags: ['Install'],
      summary: 'Verify host PAM credentials (install step 1)',
      description: 'Deno self-hosted only.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/InstallBootstrapRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Host credentials verified',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/InstallBootstrapResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '401': {
          description: 'Invalid credentials',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'Instance already configured',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/install/v1/': {
    post: {
      tags: ['Install'],
      summary: 'Complete initial install (install step 2)',
      description:
        'Deno self-hosted only. Creates org, team, superadmin, and session. Requires host credentials as `username`/`password`.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/InstallRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Install complete; superadmin session cookie set',
          headers: {
            'Set-Cookie': {
              schema: { type: 'string' },
              description: 'Signed session cookie',
            },
          },
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SessionResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request or install failed',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '401': {
          description: 'Invalid host credentials',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'Instance already configured',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
}
