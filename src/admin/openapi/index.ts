import { resolveSessionCookieName } from '../../client/authn/crypto.ts'
import { ADMIN_API_PREFIX } from '../../surfaces.ts'

const cookieSecurity = [{ cookieAuth: [] }] as const

/** Hand-authored OpenAPI 3.1 spec for documented admin REST routes. */
export function getAdminOpenApiSpec(
  serverUrl: string,
  opts?: { devSurface?: boolean },
): object {
  const sessionCookieName = resolveSessionCookieName(serverUrl)

  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboPanel Admin API',
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
        PublicUrlsResponse: {
          type: 'object',
          required: ['ok', 'urls'],
          properties: {
            ok: { type: 'boolean', const: true },
            urls: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        PublicUrlsPutBody: {
          type: 'object',
          required: ['urls'],
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        PublicUrlsPutResponse: {
          type: 'object',
          required: ['ok', 'urls', 'applied'],
          properties: {
            ok: { type: 'boolean', const: true },
            urls: {
              type: 'array',
              items: { type: 'string' },
            },
            applied: { type: 'boolean', const: false },
          },
        },
        PublicUrlsValidationError: {
          type: 'object',
          required: ['ok', 'error', 'invalid'],
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string' },
            invalid: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        PublicUrlsApplyBody: {
          type: 'object',
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        PublicUrlsApplyResponse: {
          type: 'object',
          required: ['ok', 'applied'],
          properties: {
            ok: { type: 'boolean' },
            applied: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        PublicUrlsApplyUnavailable: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string' },
          },
        },
      },
    },
    paths: {
      [`${ADMIN_API_PREFIX}/instance/public-urls`]: {
        get: {
          summary: 'List configured public URLs',
          security: [...cookieSecurity],
          responses: {
            '200': {
              description: 'Persisted public URL entries',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicUrlsResponse' },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden — requires admin or superadmin role' },
          },
        },
        put: {
          summary: 'Persist public URL entries',
          security: [...cookieSecurity],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicUrlsPutBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'URLs persisted (apply step not run)',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicUrlsPutResponse' },
                },
              },
            },
            '400': { description: 'Invalid request body' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden — requires admin or superadmin role' },
            '422': {
              description: 'One or more URL entries failed validation',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicUrlsValidationError' },
                },
              },
            },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/instance/public-urls/apply`]: {
        post: {
          summary: 'Apply public URLs to co-located daemon (cert regen + Caddy reload)',
          description:
            'Deno only. Sends a public-urls-update WS message to the co-located daemon. ' +
            'Optional body persists URLs before apply. Workers returns 422.',
          security: [...cookieSecurity],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicUrlsApplyBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'URLs applied on the co-located host',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicUrlsApplyResponse' },
                },
              },
            },
            '400': { description: 'Invalid request body' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden — requires admin or superadmin role' },
            '422': {
              description: 'Validation failure or Workers runtime (cert apply not applicable)',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/PublicUrlsValidationError' },
                      { $ref: '#/components/schemas/PublicUrlsApplyUnavailable' },
                    ],
                  },
                },
              },
            },
            '500': {
              description: 'Daemon reported failure or apply timed out',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicUrlsApplyResponse' },
                },
              },
            },
            '503': {
              description: 'Co-located daemon not connected',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicUrlsApplyUnavailable' },
                },
              },
            },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/connections`]: {
        get: {
          summary: 'List connected daemons',
          security: [...cookieSecurity],
          responses: {
            '200': { description: 'Online daemon connections' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden' },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/events`]: {
        get: {
          summary: 'Collect recent daemon events across the fleet',
          security: [...cookieSecurity],
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer' },
            },
          ],
          responses: {
            '200': { description: 'Fleet event log entries' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden' },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/commands`]: {
        get: {
          summary: 'Collect recent daemon commands across the fleet',
          security: [...cookieSecurity],
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer' },
            },
          ],
          responses: {
            '200': { description: 'Fleet command history' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden' },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/broadcast`]: {
        post: {
          summary: 'Broadcast a payload to all connected daemons',
          security: [...cookieSecurity],
          responses: {
            '200': { description: 'Broadcast accepted' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden' },
          },
        },
      },
      ...(opts?.devSurface
        ? {
          [`${ADMIN_API_PREFIX}/daemon/command`]: {
            post: {
              summary: 'Run a shell command on all connected daemons (dev superadmin only)',
              security: [...cookieSecurity],
              responses: {
                '200': { description: 'Command dispatched' },
                '401': { description: 'Unauthorized' },
                '403': { description: 'Forbidden — requires superadmin role' },
              },
            },
          },
        }
        : {}),
      [`${ADMIN_API_PREFIX}/instance/addresses`]: {
        get: {
          summary: 'Collect instance network addresses',
          description: 'Deno only. Workers returns 422 with an empty address payload.',
          security: [...cookieSecurity],
          responses: {
            '200': { description: 'Instance address summary' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden' },
            '422': { description: 'Not available on Workers runtime' },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/daemon/addresses`]: {
        get: {
          summary: 'Collect network addresses from all connected daemons',
          security: [...cookieSecurity],
          responses: {
            '200': { description: 'Per-daemon address summaries' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden' },
          },
        },
      },
    },
  }
}
