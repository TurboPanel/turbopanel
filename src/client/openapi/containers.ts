import { buildResourceCrudPaths } from './shared.ts'

export const containerSchemas = {
  ContainerRow: {
    type: 'object',
    required: [
      'id',
      'serviceId',
      'environmentId',
      'serverId',
      'containerName',
      'status',
      'role',
      'composeServiceName',
      'ordinal',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      serviceId: { type: 'string' },
      environmentId: {
        type: 'string',
        description:
          "Denormalized `service.environmentId` — lets a client group a project-wide list by environment without a request per environment.",
      },
      serverId: { type: 'string' },
      containerId: {
        type: 'string',
        nullable: true,
        description:
          'Docker container id; null between pre-allocation and the daemon report.',
      },
      containerName: { type: 'string' },
      status: { type: 'string' },
      role: {
        type: 'string',
        enum: ['service', 'ingress', 'turbopanel'],
        default: 'service',
        description:
          "Allocator-owned; `'service'` is the ordinary workload/engine replica, `'ingress'` is the per-service Traefik container or the shared per-server ProxySQL managed-ingress frontend (both named `<service.id>-in` at ordinal 1), and `'turbopanel'` is the platform `turbopanel-system` stack (`database` / `queue` / `analytics`) plus Orchestrator (`-ha`).",
      },
      composeServiceName: { type: 'string' },
      ordinal: {
        type: 'integer',
        minimum: 1,
        default: 1,
        description:
          '1-based instance index within the (service, server) pair.',
      },
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
      ordinal: {
        type: 'integer',
        minimum: 1,
        default: 1,
        description:
          '1-based instance index within the (service, server) pair.',
      },
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
listGet.get.parameters.push(
  {
    name: 'serverId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Filter containers hosted on a server',
  },
  {
    name: 'environmentId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Filter containers linked to an environment',
  },
  {
    name: 'projectId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description:
      "Filter containers across every environment of a project — one call instead of one per environment",
  },
)
