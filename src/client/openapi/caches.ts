import { CACHE_ACCESS, CACHE_STATUSES } from '../../features/caches/vocabulary.ts'
import { clientErrorJson, resourceErrorResponses } from './shared.ts'

export const cacheSchemas = {
  CacheRow: {
    type: 'object',
    required: ['id', 'name', 'engine', 'version', 'status', 'access', 'maxMemoryMb', 'keyPrefix'],
    description:
      'A project cache: one Valkey process run as a Hosting Account. The login password is never returned.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      engine: { type: 'string', enum: ['valkey'] },
      version: { type: 'string', description: 'Engine series, such as `8.1`.' },
      status: { type: 'string', enum: [...CACHE_STATUSES] },
      access: { type: 'string', enum: [...CACHE_ACCESS] },
      port: {
        type: ['integer', 'null'],
        description: 'Loopback port; set only for `port` access.',
      },
      maxMemoryMb: { type: 'integer' },
      keyPrefix: {
        type: 'string',
        description: 'Prefix of the variable names, `REDIS` by default.',
      },
      principalId: { type: 'string', format: 'uuid' },
      hostingAccount: { type: 'string' },
      serverId: { type: 'string', format: 'uuid' },
      variables: { type: 'array', items: { type: 'string' } },
      runtimeVersion: { type: ['string', 'null'] },
      lastError: { type: ['string', 'null'] },
      appliedAt: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  CreateCacheRequest: {
    type: 'object',
    required: ['name', 'principalId'],
    properties: {
      name: { type: 'string', description: 'Lower case letters, digits and dashes.' },
      principalId: {
        type: 'string',
        format: 'uuid',
        description: 'The Hosting Account that runs it.',
      },
      access: { type: 'string', enum: [...CACHE_ACCESS], description: '`socket` by default.' },
      maxMemoryMb: { type: 'integer', minimum: 16, maximum: 4096, description: '64 by default.' },
      keyPrefix: { type: 'string', description: '`REDIS` by default.' },
    },
  },
  UpdateCacheRequest: {
    type: 'object',
    properties: {
      access: { type: 'string', enum: [...CACHE_ACCESS] },
      maxMemoryMb: { type: 'integer', minimum: 16, maximum: 4096 },
      keyPrefix: { type: 'string' },
    },
  },
}

const security = [{ cookieAuth: [] }]
const environmentParam = {
  name: 'environmentId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
}
const cacheParam = { name: 'cacheId', in: 'path', required: true, schema: { type: 'string' } }

const writeErrors = {
  ...resourceErrorResponses({ badRequest: true, notFound: true }),
  '409': {
    description:
      'daemon_update_needed (the server daemon cannot run caches); environment_not_placed; cache_name_taken; cache_prefix_taken; cache_key_conflict; too_many_caches',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '422': {
    description: 'principal_not_in_environment; cache_memory_over_ceiling',
    content: { 'application/json': { schema: clientErrorJson } },
  },
}

export const cachePaths = {
  '/api/client/v1/environments/{environmentId}/caches': {
    get: {
      tags: ['Environments'],
      summary: 'List the project caches of an environment',
      security,
      parameters: [environmentParam],
      responses: {
        '200': {
          description: 'Caches',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['caches'],
                properties: {
                  caches: { type: 'array', items: { $ref: '#/components/schemas/CacheRow' } },
                },
              },
            },
          },
        },
        ...resourceErrorResponses({ notFound: true }),
      },
    },
    post: {
      tags: ['Environments'],
      summary: 'Add a project cache',
      security,
      parameters: [environmentParam],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CreateCacheRequest' } },
        },
      },
      responses: {
        '201': {
          description: 'Created; `applied` says whether the host was asked to start it.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  cache: { $ref: '#/components/schemas/CacheRow' },
                  applied: { type: 'boolean' },
                },
              },
            },
          },
        },
        ...writeErrors,
      },
    },
  },
  '/api/client/v1/environments/{environmentId}/caches/{cacheId}': {
    patch: {
      tags: ['Environments'],
      summary: 'Change a project cache (a memory limit or access change restarts it)',
      security,
      parameters: [environmentParam, cacheParam],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/UpdateCacheRequest' } },
        },
      },
      responses: {
        '200': {
          description: 'Updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  cache: { $ref: '#/components/schemas/CacheRow' },
                  applied: { type: 'boolean' },
                },
              },
            },
          },
        },
        ...writeErrors,
      },
    },
    delete: {
      tags: ['Environments'],
      summary: 'Remove a project cache',
      description:
        'The cached data is deleted unless `deleteData=false`. A cache on an offline server is removed from the record only (`removed: record_only`).',
      security,
      parameters: [
        environmentParam,
        cacheParam,
        {
          name: 'deleteData',
          in: 'query',
          required: false,
          schema: { type: 'boolean', default: true },
        },
      ],
      responses: {
        '200': {
          description: 'Removed',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  removed: { type: 'string', enum: ['host', 'record_only'] },
                  applied: { type: 'boolean' },
                },
              },
            },
          },
        },
        ...writeErrors,
      },
    },
  },
}
