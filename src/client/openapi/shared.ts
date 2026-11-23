export const clientErrorJson = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
}

export const sharedSchemas = {
  UpdateEntityRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
    },
  },
}

export function resourceErrorResponses(options?: {
  badRequest?: boolean
  forbidden?: boolean
  notFound?: boolean
}) {
  const responses: Record<string, unknown> = {
    '401': {
      description: 'Unauthorized',
      content: { 'application/json': { schema: clientErrorJson } },
    },
    '503': {
      description: 'Database unavailable',
      content: { 'application/json': { schema: clientErrorJson } },
    },
  }
  if (options?.badRequest) {
    responses['400'] = {
      description: 'Invalid request',
      content: { 'application/json': { schema: clientErrorJson } },
    }
  }
  if (options?.forbidden !== false) {
    responses['403'] = {
      description: 'Forbidden',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
    }
  }
  if (options?.notFound) {
    responses['404'] = {
      description: 'Not found',
      content: { 'application/json': { schema: clientErrorJson } },
    }
  }
  return responses
}

export type ResourceCrudConfig = {
  plural: string
  singular: string
  listSchema: string
  rowSchema: string
  createSchema: string
  patchSchema?: string
  createBodyRequired?: boolean
  parentQuery?: { name: string; description: string }
  tag?: string
  /** Extra top-level properties on the `GET /{id}` response beside the row. */
  detailExtraProperties?: Record<string, unknown>
}

function defaultResourceTag(plural: string): string {
  return plural.charAt(0).toUpperCase() + plural.slice(1)
}

export function buildResourceCrudPaths(config: ResourceCrudConfig): Record<string, unknown> {
  const base = `/api/client/v1/${config.plural}`
  const idPath = `${base}/{id}`
  const security = [{ cookieAuth: [] }]
  const tag = config.tag ?? defaultResourceTag(config.plural)
  const singleEntitySchema = {
    type: 'object',
    required: [config.singular],
    properties: {
      [config.singular]: { $ref: `#/components/schemas/${config.rowSchema}` },
      ...config.detailExtraProperties,
    },
  }

  const listGet: Record<string, unknown> = {
    tags: [tag],
    summary: `List ${config.plural}`,
    security,
    responses: {
      '200': {
        description: `Visible ${config.plural} for the signed-in organization`,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${config.listSchema}` },
          },
        },
      },
      ...resourceErrorResponses({ forbidden: false }),
    },
  }

  if (config.parentQuery) {
    listGet.parameters = [
      {
        name: config.parentQuery.name,
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: config.parentQuery.description,
      },
    ]
  }

  return {
    [base]: {
      get: listGet,
      post: {
        tags: [tag],
        summary: `Create ${config.singular}`,
        security,
        requestBody: {
          required: config.createBodyRequired ?? true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${config.createSchema}` },
            },
          },
        },
        responses: {
          '200': {
            description: `${config.singular} created`,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EntityOkResponse' },
              },
            },
          },
          ...resourceErrorResponses({ badRequest: true, notFound: true }),
        },
      },
    },
    [idPath]: {
      get: {
        tags: [tag],
        summary: `Get ${config.singular}`,
        security,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: `${config.singular} details`,
            content: {
              'application/json': { schema: singleEntitySchema },
            },
          },
          ...resourceErrorResponses({ notFound: true }),
        },
      },
      patch: {
        tags: [tag],
        summary: `Update ${config.singular}`,
        security,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: `#/components/schemas/${config.patchSchema ?? 'UpdateEntityRequest'}`,
              },
            },
          },
        },
        responses: {
          '200': {
            description: `${config.singular} updated`,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateEntityOkResponse' },
              },
            },
          },
          ...resourceErrorResponses({ badRequest: true, notFound: true }),
        },
      },
      delete: {
        tags: [tag],
        summary: `Delete ${config.singular}`,
        security,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: `${config.singular} deleted`,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateEntityOkResponse' },
              },
            },
          },
          ...resourceErrorResponses({ notFound: true }),
        },
      },
    },
  }
}

/**
 * Adds the required `confirmName` query parameter, and the 400
 * `confirm_name_required` it can cause, to a delete operation. `noun` is how
 * the message names the thing ("server", "Hosting Account"); `nameIs` says
 * which value counts as its name.
 */
export function withConfirmName<
  T extends { parameters?: unknown[]; responses: Record<string | number, unknown> },
>(operation: T, noun: string, nameIs: string): T {
  const existing = operation.responses['400'] as { description?: string } | undefined
  const refusal = `\`confirm_name_required\` (message "Type the ${noun} name to delete this ${noun}.") when \`confirmName\` is missing or is not exactly the ${noun}'s name; nothing changed.`
  return {
    ...operation,
    parameters: [
      ...(operation.parameters ?? []),
      {
        name: 'confirmName',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: `The ${noun}'s exact name (${nameIs}). Case and spaces count.`,
      },
    ],
    responses: {
      ...operation.responses,
      '400': {
        description: existing?.description ? `${existing.description}; or ${refusal}` : refusal,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['error'],
              properties: {
                error: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }
}

/** `paths` with the `delete` operation at `key` wrapped by {@link withConfirmName}. */
export function withConfirmNameOnDelete(
  paths: Record<string, unknown>,
  key: string,
  noun: string,
  nameIs: string
): Record<string, unknown> {
  type Operation = { parameters?: unknown[]; responses: Record<string, unknown> }
  const item = paths[key] as { delete: Operation } & Record<string, unknown>
  return { ...paths, [key]: { ...item, delete: withConfirmName(item.delete, noun, nameIs) } }
}

type JsonSchema = Record<string, unknown>

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict with the current state',
  422: 'Refused',
  429: 'Too many requests',
  502: 'Upstream failure',
  503: 'Unavailable',
}

/** `{ $ref }` to a component schema. */
export function schemaRef(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` }
}

/**
 * One cookie-authenticated JSON operation, so a spec file states what the
 * route takes and returns instead of repeating the envelope. Path parameters
 * come from `{name}` segments in `path`. `errors` adds to the 401 and 503
 * every session route can answer; each is `{ error: string }` unless a
 * `detail` text is given for that status.
 */
export function jsonOperation(config: {
  path: string
  tag: string
  summary: string
  description?: string
  query?: { name: string; description: string; schema?: JsonSchema; required?: boolean }[]
  body?: JsonSchema
  bodyRequired?: boolean
  ok: JsonSchema | null
  okStatus?: '200' | '201'
  okDescription?: string
  errors?: number[]
  detail?: Record<number, string>
  anonymous?: boolean
}): Record<string, unknown> {
  const pathParams = [...config.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }))
  const queryParams = (config.query ?? []).map((q) => ({
    name: q.name,
    in: 'query',
    required: q.required ?? false,
    schema: q.schema ?? { type: 'string' },
    description: q.description,
  }))
  const parameters = [...pathParams, ...queryParams]
  const statuses = config.anonymous ? [503] : [401, 503]
  for (const status of config.errors ?? []) {
    if (!statuses.includes(status)) statuses.push(status)
  }
  const responses: Record<string, unknown> = {
    [config.okStatus ?? '200']: {
      description: config.okDescription ?? 'Done',
      ...(config.ok ? { content: { 'application/json': { schema: config.ok } } } : {}),
    },
  }
  for (const status of [...statuses].sort((a, b) => a - b)) {
    responses[String(status)] = {
      description: config.detail?.[status] ?? ERROR_DESCRIPTIONS[status] ?? 'Error',
      content: { 'application/json': { schema: clientErrorJson } },
    }
  }
  return {
    tags: [config.tag],
    summary: config.summary,
    ...(config.description ? { description: config.description } : {}),
    ...(config.anonymous ? {} : { security: [{ cookieAuth: [] }] }),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(config.body
      ? {
          requestBody: {
            required: config.bodyRequired ?? true,
            content: { 'application/json': { schema: config.body } },
          },
        }
      : {}),
    responses,
  }
}
