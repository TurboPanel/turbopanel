export const authSchemas = {
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
  SignUpRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', format: 'password' },
    },
  },
  SignUpResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean', const: true },
    },
  },
  VerifyEmailResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean', const: true },
    },
  },
}

export const authPaths: Record<string, unknown> = {
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
  '/api/client/v1/auth/sign-up': {
    post: {
      tags: ['auth'],
      summary: 'Create a user account when sign-up is enabled',
      description:
        'Creates a regular user account when sign-up is enabled (`IS_SIGNUP_ENABLED` in DB or `TURBOPANEL_IS_SIGNUP_ENABLED` env override). No session is returned — the user must sign in after verifying email.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SignUpRequest' },
          },
        },
      },
      responses: {
        '201': {
          description: 'Account created; verification email queued when available',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SignUpResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request body or validation error',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Install incomplete or sign-up disabled',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'Email already registered',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '500': {
          description: 'Sign-up failed',
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
  '/api/client/v1/auth/verify-email': {
    get: {
      tags: ['auth'],
      summary: 'Verify email with a one-time token',
      description:
        'Consumes a 24-hour email verification token and sets `user.isEmailVerified` to true.',
      parameters: [
        {
          name: 'token',
          in: 'query',
          required: true,
          schema: { type: 'string' },
          description: 'Verification token from the signup email link',
        },
      ],
      responses: {
        '200': {
          description: 'Email verified',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VerifyEmailResponse' },
            },
          },
        },
        '400': {
          description: 'Missing, invalid, or expired token',
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
