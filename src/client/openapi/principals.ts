import { buildResourceCrudPaths, resourceErrorResponses } from './shared.ts'

export const principalSchemas = {
  PrincipalRow: {
    type: 'object',
    required: [
      'id',
      'kind',
      'provider',
      'username',
      'serviceIds',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      kind: {
        type: 'string',
        enum: ['system', 'database'],
        description: 'Host/PAM account (`system`) or database engine account (`database`)',
      },
      provider: {
        type: 'string',
        enum: ['pam', 'postgres', 'mysql', 'redis'],
      },
      username: {
        type: 'string',
        description:
          'Account name matching `^[A-Za-z_][A-Za-z0-9_-]*$` (1–255 chars). Never unique globally.',
      },
      metadata: {
        type: 'object',
        nullable: true,
        description: 'Optional account metadata (`uid` / `gid` / `home`)',
      },
      options: { type: 'object', nullable: true },
      serviceIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Service ids this principal is assigned to',
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    description:
      'Principal identity. The `password` column is write-only and is never included in responses.',
  },
  PrincipalsResponse: {
    type: 'object',
    required: ['principals'],
    properties: {
      principals: {
        type: 'array',
        items: { $ref: '#/components/schemas/PrincipalRow' },
      },
    },
  },
  CreatePrincipalRequest: {
    type: 'object',
    required: ['kind', 'provider', 'username', 'serviceIds'],
    properties: {
      kind: { type: 'string', enum: ['system', 'database'] },
      provider: { type: 'string', enum: ['pam', 'postgres', 'mysql', 'redis'] },
      username: { type: 'string' },
      metadata: { type: 'object' },
      options: { type: 'object' },
      serviceIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        description: 'At least one service id in the session organization',
      },
    },
    description: 'Does not accept `password` — use POST /principals/{id}/password instead.',
  },
  UpdatePrincipalRequest: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['system', 'database'] },
      provider: { type: 'string', enum: ['pam', 'postgres', 'mysql', 'redis'] },
      username: { type: 'string' },
      metadata: { type: 'object' },
      options: { type: 'object' },
      serviceIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        description: 'When provided, replaces the full assignment set',
      },
    },
    description: 'Does not accept `password` — use POST /principals/{id}/password instead.',
  },
  SetPrincipalPasswordRequest: {
    type: 'object',
    required: ['password'],
    properties: {
      password: {
        type: 'string',
        description:
          'Write-only credential. Sealing/tpdaemon encryption is a future phase; the value is never returned by GET.',
      },
    },
  },
}

const uuidPathId = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const principalCrudPaths = buildResourceCrudPaths({
  plural: 'principals',
  singular: 'principal',
  tag: 'Principals',
  listSchema: 'PrincipalsResponse',
  rowSchema: 'PrincipalRow',
  createSchema: 'CreatePrincipalRequest',
  patchSchema: 'UpdatePrincipalRequest',
  parentQuery: {
    name: 'serviceId',
    description: 'Filter principals assigned to a service (via assignment)',
  },
})

const listOps = principalCrudPaths['/api/client/v1/principals'] as {
  get: { parameters?: Array<{ name: string; schema?: Record<string, unknown> }> }
  post: unknown
}
const listServiceId = listOps.get.parameters?.find((p) => p.name === 'serviceId')
if (listServiceId) {
  listServiceId.schema = { type: 'string', format: 'uuid' }
}

const idOps = principalCrudPaths['/api/client/v1/principals/{id}'] as {
  get: { parameters: unknown[] }
  patch: { parameters: unknown[] }
  delete: { parameters: unknown[] }
}
idOps.get.parameters = [uuidPathId]
idOps.patch.parameters = [uuidPathId]
idOps.delete.parameters = [uuidPathId]

export const principalPaths = {
  ...principalCrudPaths,
  '/api/client/v1/principals/{id}/password': {
    post: {
      tags: ['Principals'],
      summary: 'Set or reset principal password',
      description:
        'Write-only password set/reset. Sealing as tpsecret/tpdaemon envelopes and daemon decrypt are a deliberate future phase. The value is never returned by any GET.',
      security: [{ cookieAuth: [] }],
      parameters: [uuidPathId],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SetPrincipalPasswordRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Password updated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateEntityOkResponse' },
            },
          },
        },
        ...resourceErrorResponses({ badRequest: true, notFound: true }),
      },
    },
  },
}
