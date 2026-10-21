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
      slug: {
        type: ['string', 'null'],
        description:
          "Folder name under the site owner's tree (`<scope>/services/<slug>`). Null until set: a " +
          'deploy picks one (the domain for web hosting) when the first folder is planned. Locked ' +
          'once the service has a folder on any server.',
      },
      common: {
        type: 'boolean',
        description:
          'True when the folder is in the `common` scope shared by environments of any project ' +
          'that use the same site owner. Chosen before the first folder exists, then locked.',
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
      // Last daemon report; read-only, absent until the service's server reports it.
      runState: { $ref: '#/components/schemas/ServiceRunState' },
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
  ServiceRunState: {
    type: 'object',
    required: ['state', 'running', 'restartCount', 'lastError', 'asOf'],
    description:
      "The daemon's last report of this service's run state, read-only. Ephemeral: it " +
      'is the latest report, not a history, and is absent until the service has been reported. ' +
      'A deploy only reports `running` after the container has stayed up for 60 seconds.',
    properties: {
      state: {
        type: 'string',
        enum: [
          'starting',
          'running',
          'unhealthy',
          'crashing',
          'stopped',
          'stopped_after_crashes',
          'unknown',
        ],
        description:
          '`crashing` while Docker keeps restarting the container; `stopped_after_crashes` ' +
          'once it is down at or past 10 restarts. A service on several containers reports its worst.',
      },
      running: {
        type: 'boolean',
        description: 'True only when `state` is `running`.',
      },
      restartCount: { type: 'integer', minimum: 0 },
      lastError: {
        type: ['string', 'null'],
        description: 'Last log line of the failing container, at most 400 characters.',
      },
      asOf: {
        type: 'string',
        format: 'date-time',
        description: 'When the daemon last saw this exact state change.',
      },
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
      slug: {
        type: 'string',
        description:
          'Folder name (lowercase letters, digits, dots, hyphens and underscores, up to 63). ' +
          '**400** `invalid_directory_name`; **409** `directory_name_taken` (another service of ' +
          'the site owner has it in the same place), `directory_name_typed_in_uuid_mode`, or ' +
          '`service_slug_locked` once the service has a folder.',
      },
      directoryName: {
        type: 'string',
        enum: ['slug', 'uuid'],
        description: 'Which kind of name; only accepted when the organization allows both.',
      },
      common: {
        type: 'boolean',
        description:
          'Share the service across environments. Only before its first folder exists: **409** ' +
          '`scope_locked` after, or `common_asset_in_use` while another environment uses it.',
      },
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
