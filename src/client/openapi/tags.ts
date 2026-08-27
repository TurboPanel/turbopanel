import { buildResourceCrudPaths, clientErrorJson, resourceErrorResponses } from './shared.ts'

export const tagSchemas = {
  TagRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      organizationId: { type: 'string' },
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      color: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  TagsResponse: {
    type: 'object',
    required: ['tags'],
    properties: {
      tags: {
        type: 'array',
        items: { $ref: '#/components/schemas/TagRow' },
      },
    },
  },
  CreateTagRequest: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      color: {
        type: ['string', 'null'],
        description: 'Optional UI token: `#RGB` or `#RRGGBB`',
      },
    },
  },
  UpdateTagRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      color: {
        type: ['string', 'null'],
        description: 'Optional UI token: `#RGB` or `#RRGGBB`; null/empty clears',
      },
    },
  },
  MarkerRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tagId: { type: 'string' },
      serverId: { type: 'string' },
      workspaceId: { type: 'string' },
      projectId: { type: 'string' },
      environmentId: { type: 'string' },
      serviceId: { type: 'string' },
      datacenterId: { type: 'string' },
      storageId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  MarkersResponse: {
    type: 'object',
    required: ['markers'],
    properties: {
      markers: {
        type: 'array',
        items: { $ref: '#/components/schemas/MarkerRow' },
      },
    },
  },
  SetMarkersRequest: {
    type: 'object',
    required: ['tagIds'],
    description:
      'Exactly one of serverId, workspaceId, projectId, environmentId, serviceId, datacenterId, storageId plus tagIds (replace-all).',
    properties: {
      serverId: { type: 'string' },
      workspaceId: { type: 'string' },
      projectId: { type: 'string' },
      environmentId: { type: 'string' },
      serviceId: { type: 'string' },
      datacenterId: { type: 'string' },
      storageId: { type: 'string' },
      tagIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tag ids to apply; empty list clears all markers on the parent',
      },
    },
  },
}

const parentQueryParameters = [
  {
    name: 'serverId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'List tags applied to this server',
  },
  {
    name: 'workspaceId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'List tags applied to this workspace',
  },
  {
    name: 'projectId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'List tags applied to this project',
  },
  {
    name: 'environmentId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'List tags applied to this environment',
  },
  {
    name: 'serviceId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'List tags applied to this service',
  },
  {
    name: 'datacenterId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'List tags applied to this datacenter',
  },
  {
    name: 'storageId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'List tags applied to this storage identity',
  },
] as const

const basePaths = buildResourceCrudPaths({
  plural: 'tags',
  singular: 'tag',
  tag: 'Tags',
  listSchema: 'TagsResponse',
  rowSchema: 'TagRow',
  createSchema: 'CreateTagRequest',
  patchSchema: 'UpdateTagRequest',
})

const tagsBasePath = '/api/client/v1/tags'
const tagIdPath = `${tagsBasePath}/{id}`
const markersPath = '/api/client/v1/markers'

const conflictResponse = {
  '409': {
    description: 'tag_name_in_use',
    content: { 'application/json': { schema: clientErrorJson } },
  },
}

export const tagPaths = {
  ...basePaths,
  [tagsBasePath]: {
    ...(basePaths[tagsBasePath] as Record<string, unknown>),
    get: {
      ...((basePaths[tagsBasePath] as Record<string, unknown>).get as Record<string, unknown>),
      parameters: parentQueryParameters,
    },
    post: {
      ...((basePaths[tagsBasePath] as Record<string, unknown>).post as Record<string, unknown>),
      responses: {
        ...(((basePaths[tagsBasePath] as Record<string, unknown>).post as Record<string, unknown>)
          .responses as Record<string, unknown>),
        ...conflictResponse,
      },
    },
  },
  [tagIdPath]: {
    ...(basePaths[tagIdPath] as Record<string, unknown>),
    patch: {
      ...((basePaths[tagIdPath] as Record<string, unknown>).patch as Record<string, unknown>),
      responses: {
        ...(((basePaths[tagIdPath] as Record<string, unknown>).patch as Record<string, unknown>)
          .responses as Record<string, unknown>),
        ...conflictResponse,
      },
    },
  },
  [markersPath]: {
    get: {
      tags: ['Tags'],
      summary: 'List markers for a tag',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'tagId',
          in: 'query',
          required: true,
          schema: { type: 'string' },
          description: 'Tag whose entity markers to list',
        },
      ],
      responses: {
        '200': {
          description: 'Markers (entities carrying this tag)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MarkersResponse' },
            },
          },
        },
        ...resourceErrorResponses({ badRequest: true, notFound: true }),
      },
    },
    put: {
      tags: ['Tags'],
      summary: 'Replace tags on an entity',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SetMarkersRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Tags on the entity after replace-all',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'tags'],
                properties: {
                  ok: { type: 'boolean' },
                  tags: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/TagRow' },
                  },
                },
              },
            },
          },
        },
        ...resourceErrorResponses({ badRequest: true, notFound: true }),
      },
    },
  },
}
