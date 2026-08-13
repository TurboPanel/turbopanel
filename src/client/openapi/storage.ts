import { buildResourceCrudPaths, resourceErrorResponses } from './shared.ts'

const storageKindEnum = ['volume', 'directory', 'file'] as const
const accessModeEnum = ['single_writer', 'multi_reader', 'multi_writer'] as const
const retentionEnum = ['retain', 'delete'] as const
const locationProviderEnum = ['docker', 'path'] as const
const locationRoleEnum = ['primary', 'replica', 'scratch', 'archive'] as const
const locationStateEnum = [
  'pending',
  'materializing',
  'ready',
  'syncing',
  'stale',
  'failed',
  'retiring',
] as const

export const storageSchemas = {
  StorageKind: {
    type: 'string',
    enum: [...storageKindEnum],
  },
  StorageAccessMode: {
    type: 'string',
    enum: [...accessModeEnum],
  },
  StorageRetention: {
    type: 'string',
    enum: [...retentionEnum],
  },
  LocationProvider: {
    type: 'string',
    enum: [...locationProviderEnum],
    description: 'API this slice accepts docker and path only',
  },
  LocationRole: {
    type: 'string',
    enum: [...locationRoleEnum],
  },
  LocationState: {
    type: 'string',
    enum: [...locationStateEnum],
  },
  LocationRow: {
    type: 'object',
    required: [
      'id',
      'storageId',
      'provider',
      'role',
      'state',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      storageId: { type: 'string' },
      serverId: { type: ['string', 'null'] },
      credentialId: { type: ['string', 'null'] },
      provider: { $ref: '#/components/schemas/LocationProvider' },
      role: { $ref: '#/components/schemas/LocationRole' },
      state: { $ref: '#/components/schemas/LocationState' },
      path: { type: ['string', 'null'] },
      endpoint: { type: ['string', 'null'] },
      generation: { type: 'integer' },
      resolvedSourcePath: {
        type: ['string', 'null'],
        description:
          'Explicit path, else principal volume path for path locations, else null',
      },
      metadata: { type: 'object', nullable: true },
      options: { type: 'object', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  MountRow: {
    type: 'object',
    required: [
      'id',
      'storageId',
      'serviceId',
      'destinationPath',
      'readOnly',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      storageId: { type: 'string' },
      serviceId: { type: 'string' },
      destinationPath: { type: 'string' },
      subpath: { type: ['string', 'null'] },
      readOnly: { type: 'boolean' },
      metadata: { type: 'object', nullable: true },
      options: { type: 'object', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  StorageRow: {
    type: 'object',
    required: ['id', 'organizationId', 'kind', 'name', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string' },
      organizationId: { type: 'string' },
      workspaceId: { type: ['string', 'null'] },
      projectId: { type: ['string', 'null'] },
      environmentId: { type: ['string', 'null'] },
      serviceId: { type: ['string', 'null'] },
      kind: { $ref: '#/components/schemas/StorageKind' },
      name: { type: 'string' },
      accessMode: { $ref: '#/components/schemas/StorageAccessMode' },
      retention: { $ref: '#/components/schemas/StorageRetention' },
      generation: { type: 'integer' },
      principalId: { type: ['string', 'null'] },
      metadata: { type: 'object', nullable: true },
      options: { type: 'object', nullable: true },
      locations: {
        type: 'array',
        items: { $ref: '#/components/schemas/LocationRow' },
      },
      mounts: {
        type: 'array',
        items: { $ref: '#/components/schemas/MountRow' },
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  StorageResponse: {
    type: 'object',
    required: ['storage'],
    properties: {
      storage: { $ref: '#/components/schemas/StorageRow' },
    },
  },
  StorageListResponse: {
    type: 'object',
    required: ['storage'],
    properties: {
      storage: {
        type: 'array',
        items: { $ref: '#/components/schemas/StorageRow' },
      },
    },
  },
  LocationListResponse: {
    type: 'object',
    required: ['locations'],
    properties: {
      locations: {
        type: 'array',
        items: { $ref: '#/components/schemas/LocationRow' },
      },
    },
  },
  MountListResponse: {
    type: 'object',
    required: ['mounts'],
    properties: {
      mounts: {
        type: 'array',
        items: { $ref: '#/components/schemas/MountRow' },
      },
    },
  },
  CreateLocationRequest: {
    type: 'object',
    required: ['provider', 'serverId'],
    properties: {
      provider: { $ref: '#/components/schemas/LocationProvider' },
      serverId: { type: 'string' },
      path: { type: 'string' },
      endpoint: { type: 'string' },
      role: { $ref: '#/components/schemas/LocationRole' },
      state: { $ref: '#/components/schemas/LocationState' },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
  UpdateLocationRequest: {
    type: 'object',
    properties: {
      provider: { $ref: '#/components/schemas/LocationProvider' },
      serverId: { type: ['string', 'null'] },
      path: { type: ['string', 'null'] },
      endpoint: { type: ['string', 'null'] },
      role: { $ref: '#/components/schemas/LocationRole' },
      state: { $ref: '#/components/schemas/LocationState' },
      credentialId: { type: ['string', 'null'] },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
  CreateMountRequest: {
    type: 'object',
    required: ['serviceId', 'destinationPath'],
    properties: {
      serviceId: { type: 'string' },
      destinationPath: { type: 'string' },
      subpath: { type: 'string' },
      readOnly: { type: 'boolean' },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
  UpdateMountRequest: {
    type: 'object',
    properties: {
      destinationPath: { type: 'string' },
      subpath: { type: ['string', 'null'] },
      readOnly: { type: 'boolean' },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
  CreateStorageRequest: {
    type: 'object',
    required: ['kind', 'name'],
    properties: {
      workspaceId: { type: 'string' },
      projectId: { type: 'string' },
      environmentId: { type: 'string' },
      serviceId: { type: 'string' },
      kind: { $ref: '#/components/schemas/StorageKind' },
      name: { type: 'string' },
      accessMode: { $ref: '#/components/schemas/StorageAccessMode' },
      retention: { $ref: '#/components/schemas/StorageRetention' },
      principalId: { type: 'string' },
      content: {
        type: 'string',
        description: 'Optional file bytes (max 256 KiB); sealed at rest',
      },
      metadata: { type: 'object' },
      options: { type: 'object' },
      location: { $ref: '#/components/schemas/CreateLocationRequest' },
      mount: { $ref: '#/components/schemas/CreateMountRequest' },
    },
  },
  UpdateStorageRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      accessMode: { $ref: '#/components/schemas/StorageAccessMode' },
      retention: { $ref: '#/components/schemas/StorageRetention' },
      principalId: { type: ['string', 'null'] },
      content: { type: 'string' },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
}

const nestedSecurity = [{ cookieAuth: [] }]
const nestedErrors = resourceErrorResponses({
  badRequest: true,
  notFound: true,
})

export const storagePaths = {
  ...buildResourceCrudPaths({
    plural: 'storage',
    singular: 'storage',
    tag: 'Storage',
    listSchema: 'StorageListResponse',
    rowSchema: 'StorageRow',
    createSchema: 'CreateStorageRequest',
    patchSchema: 'UpdateStorageRequest',
    parentQuery: {
      name: 'workspaceId',
      description:
        'Filter by workspace, project, environment, or service parent; omit to list org-visible storage including org-wide rows',
    },
  }),
  '/api/client/v1/storage/{id}/locations': {
    get: {
      tags: ['Storage'],
      summary: 'List locations for storage',
      security: nestedSecurity,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'Locations',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LocationListResponse' },
            },
          },
        },
        ...nestedErrors,
      },
    },
    post: {
      tags: ['Storage'],
      summary: 'Create a location',
      security: nestedSecurity,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateLocationRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'id'],
                properties: { ok: { type: 'boolean' }, id: { type: 'string' } },
              },
            },
          },
        },
        ...nestedErrors,
      },
    },
  },
  '/api/client/v1/storage/{id}/locations/{locationId}': {
    patch: {
      tags: ['Storage'],
      summary: 'Update a location',
      security: nestedSecurity,
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'locationId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateLocationRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
            },
          },
        },
        ...nestedErrors,
      },
    },
    delete: {
      tags: ['Storage'],
      summary: 'Delete a location',
      security: nestedSecurity,
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'locationId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'Deleted',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
            },
          },
        },
        ...nestedErrors,
      },
    },
  },
  '/api/client/v1/storage/{id}/mounts': {
    get: {
      tags: ['Storage'],
      summary: 'List mounts for storage',
      security: nestedSecurity,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: 'Mounts',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MountListResponse' },
            },
          },
        },
        ...nestedErrors,
      },
    },
    post: {
      tags: ['Storage'],
      summary: 'Create a mount',
      security: nestedSecurity,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateMountRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'id'],
                properties: { ok: { type: 'boolean' }, id: { type: 'string' } },
              },
            },
          },
        },
        ...nestedErrors,
      },
    },
  },
  '/api/client/v1/storage/{id}/mounts/{mountId}': {
    patch: {
      tags: ['Storage'],
      summary: 'Update a mount',
      security: nestedSecurity,
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'mountId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateMountRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
            },
          },
        },
        ...nestedErrors,
      },
    },
    delete: {
      tags: ['Storage'],
      summary: 'Delete a mount',
      security: nestedSecurity,
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'mountId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'Deleted',
          content: {
            'application/json': {
              schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
            },
          },
        },
        ...nestedErrors,
      },
    },
  },
}
