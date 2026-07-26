import { buildResourceCrudPaths } from './shared.ts'

export const containerSchemas = {
  ContainerRow: {
    type: 'object',
    required: [
      'id',
      'serviceId',
      'serverId',
      'containerId',
      'containerName',
      'status',
      'composeServiceName',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      serviceId: { type: 'string' },
      serverId: { type: 'string' },
      containerId: { type: 'string' },
      containerName: { type: 'string' },
      status: { type: 'string' },
      composeServiceName: { type: 'string' },
      metadata: {
        type: 'object',
        nullable: true,
        additionalProperties: true,
        description: 'Residual metadata only (promoted fields are top-level).',
      },
      options: { type: 'object', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ContainersResponse: {
    type: 'object',
    required: ['containers'],
    properties: {
      containers: {
        type: 'array',
        items: { $ref: '#/components/schemas/ContainerRow' },
      },
    },
  },
  CreateContainerRequest: {
    type: 'object',
    required: [
      'serviceId',
      'serverId',
      'containerId',
      'containerName',
      'status',
      'composeServiceName',
    ],
    properties: {
      serviceId: { type: 'string' },
      serverId: { type: 'string' },
      containerId: { type: 'string' },
      containerName: { type: 'string' },
      status: { type: 'string' },
      composeServiceName: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true },
      options: { type: 'object' },
    },
  },
  UpdateContainerRequest: {
    type: 'object',
    properties: {
      containerId: { type: 'string' },
      containerName: { type: 'string' },
      status: { type: 'string' },
      composeServiceName: { type: 'string' },
      metadata: { type: 'object', nullable: true, additionalProperties: true },
      options: { type: 'object', nullable: true },
    },
  },
}

export const containerPaths = buildResourceCrudPaths({
  plural: 'containers',
  singular: 'container',
  tag: 'Containers',
  listSchema: 'ContainersResponse',
  rowSchema: 'ContainerRow',
  createSchema: 'CreateContainerRequest',
  patchSchema: 'UpdateContainerRequest',
  parentQuery: {
    name: 'serviceId',
    description: 'Filter containers linked to a service',
  },
})

const listGet = containerPaths['/api/client/v1/containers'] as {
  get: { parameters?: unknown[] }
}
listGet.get.parameters ??= []
listGet.get.parameters.push({
  name: 'serverId',
  in: 'query',
  required: false,
  schema: { type: 'string' },
  description: 'Filter containers hosted on a server',
})
