import { buildResourceCrudPaths } from './shared.ts'

export const serviceSchemas = {
  ServiceRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: ['string', 'null'] },
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
        description:
          'Residual service metadata (promoted fields are top-level). `metadata.app` ' +
          'is the daemon-detected application (see `app`); a PATCH that replaces ' +
          'metadata keeps it.',
        additionalProperties: true,
      },
      // Detected application (site services); read-only, absent until detected.
      app: { $ref: '#/components/schemas/ServiceApp' },
      options: {
        type: 'object',
        nullable: true,
        description: 'Service settings (healthCheck, resources, hooks)',
        additionalProperties: true,
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ServiceApp: {
    type: 'object',
    required: ['kind'],
    description:
      "Application detected in a site service's document root at the last deploy, read-only. Detected from file names only (never from wp-config.php contents), so it " +
      'carries no secret.',
    properties: {
      kind: { type: 'string', enum: ['wordpress'] },
      version: {
        type: 'string',
        description: 'Application release, when the daemon could read it.',
      },
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
      name: { type: 'string' },
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
      name: { type: 'string' },
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
