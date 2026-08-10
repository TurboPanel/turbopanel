import { buildResourceCrudPaths, clientErrorJson } from './shared.ts'

export const variableSchemas = {
  VariableRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      organizationId: { type: ['string', 'null'] },
      workspaceId: { type: ['string', 'null'] },
      projectId: { type: ['string', 'null'] },
      environmentId: { type: ['string', 'null'] },
      serviceId: { type: ['string', 'null'] },
      hostingId: { type: ['string', 'null'] },
      serverId: { type: ['string', 'null'] },
      bindingId: {
        type: ['string', 'null'],
        description:
          'When set, this variable is system-owned by a binding; PATCH/DELETE return 403 binding_owned_variable',
      },
      key: { type: 'string' },
      isSecret: { type: 'boolean' },
      isLiteral: { type: 'boolean', description: 'Skip compose $ interpolation when true' },
      forBuild: { type: 'boolean', description: 'Inject into build.args when true' },
      forRuntime: { type: 'boolean', description: 'Inject into environment when true (default true)' },
      value: {
        type: ['string', 'null'],
        description: 'Plaintext value for non-secret variables; always null for secrets',
      },
      description: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  VariablesResponse: {
    type: 'object',
    required: ['variables'],
    properties: {
      variables: {
        type: 'array',
        items: { $ref: '#/components/schemas/VariableRow' },
      },
    },
  },
  CreateVariableRequest: {
    type: 'object',
    required: ['key'],
    description:
      'Exactly one of organizationId, workspaceId, projectId, environmentId, serviceId, hostingId, serverId must be provided.',
    properties: {
      organizationId: { type: 'string' },
      workspaceId: { type: 'string' },
      projectId: { type: 'string' },
      environmentId: { type: 'string' },
      serviceId: { type: 'string' },
      hostingId: { type: 'string' },
      serverId: { type: 'string' },
      key: { type: 'string' },
      value: { type: 'string' },
      isSecret: { type: 'boolean' },
      isLiteral: { type: 'boolean' },
      forBuild: { type: 'boolean' },
      forRuntime: { type: 'boolean' },
      description: { type: 'string' },
    },
  },
  UpdateVariableRequest: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: ['string', 'null'] },
      isSecret: { type: 'boolean' },
      isLiteral: { type: 'boolean' },
      forBuild: { type: 'boolean' },
      forRuntime: { type: 'boolean' },
      description: { type: ['string', 'null'] },
    },
  },
}

const parentQueryParameters = [
  {
    name: 'organizationId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Filter variables scoped to an organization',
  },
  {
    name: 'workspaceId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Filter variables scoped to a workspace',
  },
  {
    name: 'projectId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Filter variables scoped to a project',
  },
  {
    name: 'environmentId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Filter variables scoped to an environment',
  },
  {
    name: 'serviceId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Filter variables scoped to a service',
  },
  {
    name: 'hostingId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Filter variables scoped to a hosting',
  },
  {
    name: 'serverId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Filter variables scoped to a server',
  },
] as const

const basePaths = buildResourceCrudPaths({
  plural: 'variables',
  singular: 'variable',
  tag: 'Variables',
  listSchema: 'VariablesResponse',
  rowSchema: 'VariableRow',
  createSchema: 'CreateVariableRequest',
})

const variablesBasePath = '/api/client/v1/variables'
const variableIdPath = `${variablesBasePath}/{id}`

const conflictResponse = {
  '409': {
    description: 'Duplicate variable key in scope',
    content: { 'application/json': { schema: clientErrorJson } },
  },
}

export const variablePaths = {
  ...basePaths,
  [variablesBasePath]: {
    ...(basePaths[variablesBasePath] as Record<string, unknown>),
    get: {
      ...((basePaths[variablesBasePath] as Record<string, unknown>).get as Record<string, unknown>),
      parameters: parentQueryParameters,
    },
    post: {
      ...((basePaths[variablesBasePath] as Record<string, unknown>).post as Record<string, unknown>),
      responses: {
        ...(((basePaths[variablesBasePath] as Record<string, unknown>).post as Record<string, unknown>)
          .responses as Record<string, unknown>),
        ...conflictResponse,
        '503': {
          description: 'Encryption unavailable',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
  [variableIdPath]: {
    ...(basePaths[variableIdPath] as Record<string, unknown>),
    patch: {
      ...((basePaths[variableIdPath] as Record<string, unknown>).patch as Record<string, unknown>),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateVariableRequest' },
          },
        },
      },
      responses: {
        ...(((basePaths[variableIdPath] as Record<string, unknown>).patch as Record<string, unknown>)
          .responses as Record<string, unknown>),
        ...conflictResponse,
        '503': {
          description: 'Encryption unavailable',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
}
