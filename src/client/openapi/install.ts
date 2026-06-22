export const installOpenApiSchemas = {
  InstallStatusResponse: {
    type: 'object',
    required: ['ok', 'needsInstall', 'isInstallMode', 'isSignupEnabled'],
    description:
      'Dedicated install surface (`/api/install/v1`). On Workers, needsInstall and isInstallMode are always false; isSignupEnabled reflects DB + env. On Deno, all fields reflect self-hosted install wizard state.',
    properties: {
      ok: { type: 'boolean', const: true },
      needsInstall: {
        type: 'boolean',
        description: 'True when org + superadmin do not exist yet (Deno only).',
      },
      isInstallMode: {
        type: 'boolean',
        description: 'True while the install wizard is active (Deno only).',
      },
      isSignupEnabled: {
        type: 'boolean',
        description:
          'Whether public sign-up is enabled (DB setting or TURBOPANEL_IS_SIGNUP_ENABLED env override).',
      },
    },
  },
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
  '/api/install/v1/status': {
    get: {
      tags: ['install'],
      summary: 'Install wizard status',
      description:
        'Dedicated install surface (`/api/install/v1`). Deno self-hosted only.',
      responses: {
        '200': {
          description: 'Install status',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/InstallStatusResponse' },
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
  '/api/install/v1/bootstrap': {
    post: {
      tags: ['install'],
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
      tags: ['install'],
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
  '/api/install/v1/daemon-install.sh': {
    get: {
      tags: ['install'],
      summary: 'Daemon install script',
      description:
        'Returns a POSIX sh script for installing a managed daemon. ' +
        'Shell arguments (not HTTP query params): `--license <id:token>` (required) ' +
        'and optional `--host <instance-url>` to set TURBOPANEL_INSTANCE_URL before ' +
        'delegating to the CDN installer. Deno self-hosted only.',
      responses: {
        '200': {
          description: 'Install script',
          content: {
            'text/plain': {
              schema: { type: 'string' },
            },
          },
        },
      },
    },
  },
}
