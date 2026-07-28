import { buildResourceCrudPaths } from './shared.ts'

const storageKindEnum = ['docker_volume', 'bind_mount', 'file', 'directory'] as const

export const storageSchemas = {
  StorageKind: {
    type: 'string',
    enum: [...storageKindEnum],
  },
  StorageRow: {
    type: 'object',
    required: ['id', 'organizationId', 'serverId', 'kind', 'name', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string' },
      organizationId: { type: 'string' },
      projectId: { type: ['string', 'null'] },
      environmentId: { type: ['string', 'null'] },
      serviceId: { type: ['string', 'null'] },
      serverId: { type: 'string' },
      kind: { $ref: '#/components/schemas/StorageKind' },
      name: { type: 'string' },
      sourcePath: { type: ['string', 'null'] },
      destinationPath: { type: ['string', 'null'] },
      principalId: { type: ['string', 'null'] },
      resolvedSourcePath: {
        type: ['string', 'null'],
        description:
          'Server-derived host path; principal-owned bind mounts resolve to /srv/users/<principalId>/volumes/<storageId>',
      },
      metadata: { type: 'object', nullable: true },
      options: { type: 'object', nullable: true },
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
  CreateStorageRequest: {
    type: 'object',
    required: ['kind', 'name', 'serverId'],
    properties: {
      projectId: { type: 'string' },
      environmentId: { type: 'string' },
      serviceId: { type: 'string' },
      kind: { $ref: '#/components/schemas/StorageKind' },
      name: { type: 'string' },
      serverId: { type: 'string' },
      sourcePath: {
        type: 'string',
        description:
          'Optional for principal-owned bind mounts (instance derives /srv/users/<principalId>/volumes/<storageId>)',
      },
      destinationPath: { type: 'string' },
      principalId: { type: 'string' },
      content: {
        type: 'string',
        description: 'Optional file bytes (max 256 KiB); sealed at rest',
      },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
  UpdateStorageRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      sourcePath: { type: 'string' },
      destinationPath: { type: 'string' },
      serverId: { type: 'string' },
      principalId: { type: ['string', 'null'] },
      content: { type: 'string' },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
}

export const storagePaths = {
  ...buildResourceCrudPaths({
    plural: 'storage',
    singular: 'storage',
    tag: 'Storage',
    listSchema: 'StorageListResponse',
    rowSchema: 'StorageResponse',
    createSchema: 'CreateStorageRequest',
    patchSchema: 'UpdateStorageRequest',
    parentQuery: {
      name: 'environmentId',
      description: 'Filter storage by environment, project, or service parent',
    },
  }),
}
