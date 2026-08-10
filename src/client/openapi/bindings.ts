import { buildResourceCrudPaths, clientErrorJson } from './shared.ts'

export const bindingSchemas = {
  BindingRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      principalId: { type: 'string' },
      serviceId: { type: 'string' },
      databaseName: { type: 'string' },
      keyPrefix: { type: 'string' },
      emitEngineDefaults: { type: 'boolean' },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Env keys this binding materializes (never values)',
      },
      endpoint: {
        type: ['object', 'null'],
        properties: {
          host: { type: 'string' },
          port: { type: 'number' },
        },
      },
      engine: { type: ['string', 'null'] },
      managedId: { type: ['string', 'null'] },
      managedEnvironmentId: { type: ['string', 'null'] },
      readSplit: { type: ['boolean', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  BindingsResponse: {
    type: 'object',
    required: ['bindings'],
    properties: {
      bindings: {
        type: 'array',
        items: { $ref: '#/components/schemas/BindingRow' },
      },
    },
  },
  CreateBindingRequest: {
    type: 'object',
    required: ['principalId', 'serviceId', 'databaseName'],
    properties: {
      principalId: { type: 'string' },
      serviceId: { type: 'string' },
      databaseName: { type: 'string' },
      keyPrefix: {
        type: 'string',
        description: 'Prefix for emitted env keys (default DATABASE)',
      },
      emitEngineDefaults: {
        type: 'boolean',
        description:
          'When true, also emit unprefixed PG*/MYSQL_* engine defaults (at most one binding per service)',
      },
    },
  },
  UpdateBindingRequest: {
    type: 'object',
    properties: {
      keyPrefix: { type: 'string' },
      emitEngineDefaults: { type: 'boolean' },
    },
  },
}

const basePaths = buildResourceCrudPaths({
  plural: 'bindings',
  singular: 'binding',
  tag: 'Bindings',
  listSchema: 'BindingsResponse',
  rowSchema: 'BindingRow',
  createSchema: 'CreateBindingRequest',
  patchSchema: 'UpdateBindingRequest',
})

const bindingsBasePath = '/api/client/v1/bindings'
const bindingIdPath = `${bindingsBasePath}/{id}`

const bindingConflictResponses = {
  '409': {
    description:
      'binding_key_prefix_in_use / binding_engine_defaults_in_use / binding_key_conflict',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '422': {
    description: 'binding_endpoint_unavailable',
    content: { 'application/json': { schema: clientErrorJson } },
  },
}

export const bindingPaths = {
  ...basePaths,
  [bindingsBasePath]: {
    ...(basePaths[bindingsBasePath] as Record<string, unknown>),
    get: {
      ...((basePaths[bindingsBasePath] as Record<string, unknown>).get as Record<
        string,
        unknown
      >),
      parameters: [
        {
          name: 'serviceId',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description:
            'List bindings owned by this compose service (exactly one filter)',
        },
        {
          name: 'environmentId',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description:
            'List bindings whose consuming service is in this environment (exactly one filter)',
        },
        {
          name: 'managedEnvironmentId',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description:
            'List bindings whose principal belongs to the managed cluster in this environment (exactly one filter)',
        },
      ],
    },
    post: {
      ...((basePaths[bindingsBasePath] as Record<string, unknown>).post as Record<
        string,
        unknown
      >),
      responses: {
        ...(((basePaths[bindingsBasePath] as Record<string, unknown>).post as Record<
          string,
          unknown
        >).responses as Record<string, unknown>),
        ...bindingConflictResponses,
      },
    },
  },
  [bindingIdPath]: {
    ...(basePaths[bindingIdPath] as Record<string, unknown>),
    patch: {
      ...((basePaths[bindingIdPath] as Record<string, unknown>).patch as Record<
        string,
        unknown
      >),
      responses: {
        ...(((basePaths[bindingIdPath] as Record<string, unknown>).patch as Record<
          string,
          unknown
        >).responses as Record<string, unknown>),
        ...bindingConflictResponses,
      },
    },
  },
}
