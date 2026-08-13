import { resolveSessionCookieNameFromUrl } from '../../client/authn/crypto.ts'
import { ADMIN_API_PREFIX } from '../../surfaces.ts'

const cookieSecurity = [{ cookieAuth: [] }] as const

/** Hand-authored OpenAPI 3.1 spec for documented admin REST routes. */
export function getAdminOpenApiSpec(
  serverUrl: string,
  opts?: { devSurface?: boolean },
): object {
  const sessionCookieName = resolveSessionCookieNameFromUrl(serverUrl)

  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboPanel Admin API',
      version: '0.1.0',
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: 'Instance', description: 'Control-plane instance configuration' },
      { name: 'Settings', description: 'System settings (email, etc.)' },
      { name: 'Daemon Fleet', description: 'Fleet-wide daemon management' },
    ],
    'x-tagGroups': [
      { name: 'Instance', tags: ['Instance', 'Settings'] },
      { name: 'Fleet', tags: ['Daemon Fleet'] },
    ],
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
        EmailSettingEntry: {
          type: 'object',
          required: ['value', 'source'],
          properties: {
            value: { type: 'string', nullable: true },
            source: { type: 'string', enum: ['env', 'db', 'default'] },
          },
        },
        EmailSettingsResponse: {
          type: 'object',
          required: ['settings'],
          properties: {
            settings: {
              type: 'object',
              additionalProperties: { $ref: '#/components/schemas/EmailSettingEntry' },
            },
          },
        },
        EmailSettingsPutBody: {
          type: 'object',
          additionalProperties: { type: 'string', nullable: true },
        },
        CellPurgeBatchBody: {
          type: 'object',
          required: ['serverIds'],
          properties: {
            serverIds: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
            },
          },
        },
        CellPurgeResponse: {
          type: 'object',
          required: ['ok', 'serverId', 'purged'],
          properties: {
            ok: { type: 'boolean', const: true },
            serverId: { type: 'string' },
            purged: { type: 'boolean', const: true },
          },
        },
        CellPurgeErrorResponse: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string' },
          },
        },
        CellPurgeBatchResponse: {
          type: 'object',
          required: ['ok', 'results'],
          properties: {
            ok: { type: 'boolean', const: true },
            results: {
              type: 'array',
              items: {
                type: 'object',
                required: ['serverId', 'ok'],
                properties: {
                  serverId: { type: 'string' },
                  ok: { type: 'boolean' },
                  error: { type: 'string' },
                },
              },
            },
          },
        },
        SecretsReencryptCursor: {
          type: 'object',
          required: ['stage'],
          properties: {
            stage: {
              type: 'string',
              enum: ['variables', 'tls', 'principals', 'storage', 'credentials', 'email'],
            },
            afterId: {
              type: 'string',
              description: 'Last processed row id within the stage (resume exclusive lower bound)',
            },
          },
        },
        SecretsReencryptResponse: {
          type: 'object',
          required: [
            'ok',
            'scanned',
            'reencrypted',
            'skipped',
            'failed',
            'completed',
            'cursor',
          ],
          properties: {
            ok: { type: 'boolean', const: true },
            scanned: { type: 'integer' },
            reencrypted: { type: 'integer' },
            skipped: { type: 'integer' },
            failed: { type: 'integer' },
            completed: {
              type: 'boolean',
              description: 'True when the sweep finished; otherwise resume with `cursor`',
            },
            cursor: {
              oneOf: [
                { $ref: '#/components/schemas/SecretsReencryptCursor' },
                { type: 'null' },
              ],
            },
          },
        },
      },
    },
    paths: {
      [`${ADMIN_API_PREFIX}/instance/public-urls`]: {
        get: {
          tags: ['Instance'],
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
          tags: ['Instance'],
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
      [`${ADMIN_API_PREFIX}/settings/email`]: {
        get: {
          tags: ['Settings'],
          summary: 'Read resolved email settings',
          security: [...cookieSecurity],
          responses: {
            '200': {
              description: 'Email settings with source metadata',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/EmailSettingsResponse' },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden — requires admin or superadmin role' },
            '503': { description: 'Database unavailable' },
          },
        },
        put: {
          tags: ['Settings'],
          summary: 'Persist email settings to the database',
          description:
            'Env-overridden keys are accepted but ignored. Secret values from env are never returned. ' +
            'Send null for a key to clear a database-backed value and revert to defaults.',
          security: [...cookieSecurity],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EmailSettingsPutBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Updated settings',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/EmailSettingsResponse' },
                },
              },
            },
            '400': { description: 'Invalid request body' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden — requires admin or superadmin role' },
            '503': { description: 'Database unavailable' },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/instance/public-urls/apply`]: {
        post: {
          tags: ['Instance'],
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
          tags: ['Daemon Fleet'],
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
          tags: ['Daemon Fleet'],
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
          tags: ['Daemon Fleet'],
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
          tags: ['Daemon Fleet'],
          summary: 'Broadcast a payload to all connected daemons',
          security: [...cookieSecurity],
          responses: {
            '200': { description: 'Broadcast accepted' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden' },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/instance/addresses`]: {
        get: {
          tags: ['Instance'],
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
          tags: ['Daemon Fleet'],
          summary: 'Collect network addresses from all connected daemons',
          security: [...cookieSecurity],
          responses: {
            '200': { description: 'Per-daemon address summaries' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Forbidden' },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/cells/purge-batch`]: {
        post: {
          tags: ['Daemon Fleet'],
          summary: 'Purge daemon cells for multiple server IDs',
          description:
            'Works even when Postgres server rows are already deleted (orphaned cells). ' +
            'Per-id failures are reported in the results array.',
          security: [...cookieSecurity],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CellPurgeBatchBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Batch purge completed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CellPurgeBatchResponse' },
                },
              },
            },
            '400': { description: 'Invalid request body' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Superadmin access required' },
            '503': { description: 'Daemon cell registry unavailable' },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/cells/{serverId}/purge`]: {
        post: {
          tags: ['Daemon Fleet'],
          summary: 'Purge a single daemon cell by server ID',
          description:
            'Works even when the Postgres server row is already deleted (orphaned test-server DOs).',
          security: [...cookieSecurity],
          parameters: [
            {
              name: 'serverId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Cell purged',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CellPurgeResponse' },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Superadmin access required' },
            '500': {
              description: 'Purge failed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CellPurgeErrorResponse' },
                },
              },
            },
            '503': { description: 'Daemon cell registry unavailable' },
          },
        },
      },
      [`${ADMIN_API_PREFIX}/secrets/reencrypt`]: {
        post: {
          tags: ['Instance'],
          summary: 'Re-encrypt at-rest secrets to the current key version',
          description:
            'Bounded sweep over secret variables, TLS private keys, principal passwords, ' +
            'and SYSTEM_EMAIL secret keys. Re-seals older-version `tpsecret` blobs; skips ' +
            'current-version `tpsecret` and valid `tpdaemon` delivery envelopes; fails ' +
            'plaintext or malformed material. Pass the previous `cursor` to resume until ' +
            '`completed` is true. Concurrent sweeps return 409 `reencrypt_in_progress`.',
          security: [...cookieSecurity],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    cursor: { $ref: '#/components/schemas/SecretsReencryptCursor' },
                    limit: {
                      type: 'integer',
                      minimum: 1,
                      description: 'Max blobs to scan this call (capped server-side)',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Sweep batch finished (check `completed` / `cursor` for resume)',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SecretsReencryptResponse' },
                },
              },
            },
            '400': { description: 'Invalid cursor or limit' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Superadmin access required' },
            '409': { description: 'Another re-encryption sweep is already in progress' },
            '503': { description: 'Database or encryption unavailable' },
          },
        },
      },
    },
  }
}
