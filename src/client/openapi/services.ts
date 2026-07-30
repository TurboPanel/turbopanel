import { buildResourceCrudPaths } from './shared.ts'

export const serviceSchemas = {
  ServiceRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      environmentId: { type: 'string' },
      composeServiceName: {
        type: 'string',
        description:
          'Compose service name derived from the compose document (project base + ' +
          'environment overlay). Read-only — written only by deploy reconcile / ' +
          'managed allocation / container reconcile, never by a client request.',
      },
      metadata: {
        type: ['object', 'null'],
        description: 'Residual service metadata (promoted fields are top-level).',
        additionalProperties: true,
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ServicesResponse: {
    type: 'object',
    required: ['services'],
    properties: {
      services: {
        type: 'array',
        items: { $ref: '#/components/schemas/ServiceRow' },
      },
    },
  },
  CreateServiceRequest: {
    type: 'object',
    required: ['environmentId'],
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      environmentId: { type: 'string' },
      metadata: { type: 'object', nullable: true },
      options: {
        type: 'object',
        nullable: true,
        description: 'Service settings (healthCheck, resources, hooks)',
      },
    },
  },
  UpdateServiceRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      metadata: { type: 'object', nullable: true },
      options: {
        type: 'object',
        nullable: true,
        description: 'Service settings (healthCheck, resources, hooks)',
      },
    },
  },
}

export const servicePaths = buildResourceCrudPaths({
  plural: 'services',
  singular: 'service',
  tag: 'Services',
  listSchema: 'ServicesResponse',
  rowSchema: 'ServiceRow',
  createSchema: 'CreateServiceRequest',
  patchSchema: 'UpdateServiceRequest',
  parentQuery: {
    name: 'environmentId',
    description: 'Filter services under an environment',
  },
})

const listGet = servicePaths['/api/client/v1/services'] as {
  get: { parameters?: unknown[] }
}
listGet.get.parameters ??= []
listGet.get.parameters.push({
  name: 'composeServiceName',
  in: 'query',
  required: false,
  schema: { type: 'string' },
  description: 'Filter services by compose service name',
})
