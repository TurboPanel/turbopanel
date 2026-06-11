import { resolveSessionCookieName } from './auth/crypto.ts'

/** Hand-authored OpenAPI 3.1 spec for documented client/daemon/health routes. */
export function getOpenApiSpec(serverUrl: string): object {
  const sessionCookieName = resolveSessionCookieName(serverUrl)

  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboPanel API',
      version: '0.1.0',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: sessionCookieName,
        },
      },
      schemas: {
        OkHealth: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: true },
          },
        },
        ClientStatus: {
          type: 'object',
          required: ['ok', 'surface'],
          properties: {
            ok: { type: 'boolean', const: true },
            surface: { type: 'string', const: 'client' },
          },
        },
        ErrorResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string' },
          },
        },
        UnauthorizedResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: false },
          },
        },
        SignInRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string' },
            password: { type: 'string', format: 'password' },
          },
        },
        SessionResponse: {
          type: 'object',
          required: [
            'ok',
            'userId',
            'username',
            'email',
            'role',
            'needsInstall',
            'organizationId',
          ],
          properties: {
            ok: { type: 'boolean', const: true },
            userId: { type: ['string', 'null'] },
            username: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            role: { type: ['string', 'null'] },
            needsInstall: { type: 'boolean' },
            organizationId: { type: ['string', 'null'] },
          },
        },
        SignOutResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: true },
          },
        },
        InstallStatusResponse: {
          type: 'object',
          required: ['ok', 'needsInstall'],
          properties: {
            ok: { type: 'boolean', const: true },
            needsInstall: { type: 'boolean' },
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
          required: [
            'hostUsername',
            'hostPassword',
            'superadminEmail',
            'superadminPassword',
          ],
          properties: {
            hostUsername: { type: 'string', description: 'Host root or sudo user' },
            hostPassword: { type: 'string', format: 'password' },
            superadminEmail: { type: 'string', format: 'email' },
            superadminPassword: { type: 'string', format: 'password' },
          },
        },
        ServerRow: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: ['string', 'null'] },
            organizationId: { type: ['string', 'null'] },
            options: { type: ['object', 'null'], additionalProperties: true },
            createdAt: { type: 'string', format: 'date-time' },
            connected: { type: 'boolean' },
            hostname: { type: ['string', 'null'] },
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
        DaemonErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    paths: {
      '/api/health': {
        get: {
          tags: ['health'],
          summary: 'Health probe',
          responses: {
            '200': {
              description: 'Instance is reachable',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OkHealth' },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/status': {
        get: {
          tags: ['client'],
          summary: 'Client surface status',
          responses: {
            '200': {
              description: 'Client API is available',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ClientStatus' },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/auth/sign-in': {
        post: {
          tags: ['auth'],
          summary: 'Sign in with email credentials',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SignInRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Signed in; session cookie set',
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
              description: 'Invalid request body',
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
            '403': {
              description: 'Root account must use install wizard',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/auth/sign-out': {
        post: {
          tags: ['auth'],
          summary: 'Sign out and clear session cookie',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': {
              description: 'Signed out',
              headers: {
                'Set-Cookie': {
                  schema: { type: 'string' },
                  description: 'Clears session cookie',
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SignOutResponse' },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/auth/session': {
        get: {
          tags: ['auth'],
          summary: 'Get current session',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': {
              description: 'Active session',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SessionResponse' },
                },
              },
            },
            '401': {
              description: 'No valid session',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UnauthorizedResponse' },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/install/status': {
        get: {
          tags: ['install'],
          summary: 'Install wizard status',
          description: 'Deno self-hosted only; Workers always returns needsInstall false.',
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
      '/api/client/v1/install/bootstrap': {
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
            '404': {
              description: 'Not available on Workers',
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
      '/api/client/v1/install': {
        post: {
          tags: ['install'],
          summary: 'Complete initial install (install step 2)',
          description: 'Deno self-hosted only. Creates org, team, superadmin, and session.',
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
            '404': {
              description: 'Not available on Workers',
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
      '/api/daemon/v1/instance/ca': {
        get: {
          tags: ['daemon'],
          summary: 'Platform TLS CA certificate',
          description: 'Returns the PEM-encoded platform CA for agent trust stores.',
          responses: {
            '200': {
              description: 'PEM certificate',
              content: {
                'application/x-pem-file': {
                  schema: { type: 'string', format: 'byte' },
                },
              },
            },
            '500': {
              description: 'CA unavailable',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DaemonErrorResponse' },
                },
              },
            },
          },
        },
      },
    },
  }
}
