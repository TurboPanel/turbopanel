import { buildResourceCrudPaths } from './shared.ts'

export const workspaceSchemas = {
  WorkspaceRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      kind: {
        type: 'string',
        enum: ['user', 'turbopanel'],
        description:
          'Authorization-sensitive discriminator. TurboPanel Platform workspaces (`turbopanel`) are platform-managed and immutable through the public API.',
      },
      organizationId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  WorkspacesResponse: {
    type: 'object',
    required: ['workspaces'],
    properties: {
      workspaces: {
        type: 'array',
        items: { $ref: '#/components/schemas/WorkspaceRow' },
      },
    },
  },
  CreateWorkspaceRequest: {
    type: 'object',
    description: 'New workspaces are always created with kind=user; a caller-supplied kind is ignored.',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
    },
  },
  EntityOkResponse: {
    type: 'object',
    required: ['ok', 'id'],
    properties: {
      ok: { type: 'boolean', const: true },
      id: { type: 'string' },
    },
  },
  UpdateEntityOkResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean', const: true },
    },
  },
}

export const workspacePaths = buildResourceCrudPaths({
  plural: 'workspaces',
  singular: 'workspace',
  tag: 'Workspaces',
  listSchema: 'WorkspacesResponse',
  rowSchema: 'WorkspaceRow',
  createSchema: 'CreateWorkspaceRequest',
  createBodyRequired: false,
})
